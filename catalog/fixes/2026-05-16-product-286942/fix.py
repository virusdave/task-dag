#!/usr/bin/env python3
"""Fix product group 286942 (Herb Sour Diesel 1g): move from Pre-Rolls to
Vapes/All In One / Disposable, rewrite the description, and replace the
pre-roll-tube hero image with a Herb-branded 1g all-in-one vape image.

Background: during the 2026-05-13 purchase apply, the distributor item
"Herb - Vape - Sour Diesel - 1g" (expectedCategory Vapes / All In One /
Disposable) was mapped onto the pre-existing pre-roll variant
"Herb Sour Diesel 1g" (product 376985, group 286942). The group's
category, description, and hero image were never corrected for the fact
that the product is actually a 1g all-in-one vape.

This script:
  1. Switches to the state-level catalog dealer context.
  2. Re-categorises the group to Vapes / All In One / Disposable
     (categoryId=1087, subcategoryId=1112).
  3. Replaces the description with vape-appropriate copy.
  4. Uploads a clean Herb Sour Diesel 1g all-in-one vape image (sourced
     from a competitor menu's isolated product shot) and replaces the
     group's hero image.

Run:
  python3 catalog/fixes/2026-05-16-product-286942/fix.py            # dry run
  python3 catalog/fixes/2026-05-16-product-286942/fix.py --apply    # write
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

GROUP_ID = 286942
PRODUCT_ID = 376985
VAPES_CATEGORY_ID = 1087
ALL_IN_ONE_SUBCATEGORY_ID = 1112
# Clean isolated product shot of the Herb Sour Diesel 1g All-In-One vape
# pouch on a white background, sourced from Kaya Bliss Dispensary's
# Dutchie menu. Verified to actually depict this product (not a stock
# image) via 2026-05-16 visual inspection.
NEW_IMAGE_URL = (
    "https://s3-us-west-2.amazonaws.com/dutchie-images/"
    "fca262c8b3d151b93ac05d040c07fc29"
)

NEW_DESCRIPTION = (
    "Enjoy the classic Sour Diesel experience with the Herb Sour Diesel 1g "
    "All-In-One Vape. This 1g disposable vape is ready to use straight out of "
    "the box — no batteries, pods, or chargers needed. It delivers a simple, "
    "self-contained way to experience this well-known strain wherever you go. "
    "Herb keeps the format straightforward, making it easy to enjoy the "
    "qualities of Sour Diesel whenever you choose.\n\n"
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Actually write to Sweed.")
    args = parser.parse_args()

    sweed.switch_to_state_context()

    before = sweed.api_call("store.product.group.get", {"id": GROUP_ID})
    before_summary = {
        "id": before["id"],
        "name": before.get("name"),
        "category": (before.get("category") or {}).get("name"),
        "subcategory": (before.get("subcategory") or {}).get("name"),
        "description": before.get("description"),
        "images": [
            {"id": item.get("id"), "url": item.get("url")}
            for item in (before.get("images") or [])
        ],
    }

    print("BEFORE:")
    print(json.dumps(before_summary, indent=2))
    print()
    print(f"NEW IMAGE SOURCE: {NEW_IMAGE_URL}")

    if not args.apply:
        print("\nDry run — pass --apply to upload image and write group edit.")
        return

    print("\nUploading new hero image to Sweed blob store...")
    new_blob_id = upload_image(NEW_IMAGE_URL)
    print(f"  -> blob id {new_blob_id}")

    edit_params = {
        "id": GROUP_ID,
        "categoryId": VAPES_CATEGORY_ID,
        "subcategoryId": ALL_IN_ONE_SUBCATEGORY_ID,
        "description": NEW_DESCRIPTION,
        "imagesIds": [new_blob_id],
    }
    print("\nEDIT PARAMS:")
    print(json.dumps(edit_params, indent=2))

    sweed.api_call("store.product.group.edit", edit_params)
    after = sweed.api_call("store.product.group.get", {"id": GROUP_ID})
    after_summary = {
        "id": after["id"],
        "name": after.get("name"),
        "category": (after.get("category") or {}).get("name"),
        "subcategory": (after.get("subcategory") or {}).get("name"),
        "description": after.get("description"),
        "images": [
            {"id": item.get("id"), "url": item.get("url")}
            for item in (after.get("images") or [])
        ],
    }
    print("\nAFTER:")
    print(json.dumps(after_summary, indent=2))

    (WORKDIR / "fix_results.json").write_text(
        json.dumps(
            {
                "groupId": GROUP_ID,
                "productId": PRODUCT_ID,
                "newImageSourceUrl": NEW_IMAGE_URL,
                "before": before_summary,
                "editParams": edit_params,
                "after": after_summary,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
