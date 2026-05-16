#!/usr/bin/env python3
"""Merge the duplicate `Moony's Zooties` brand into the canonical
`Moony's` brand and disable the duplicate.

For every product group currently under `Moony's Zooties` (brand 16414):
  1. Rename each product so the `Moony's Zooties` prefix becomes
     `Moony's` (keeps the catalog consistent with the new brand).
  2. Edit the group: set `brandId` to the canonical Moony's brand
     (4408) and set `imagesIds` to `[]` so the stock images are
     removed.

After every group has been moved, disable the duplicate brand by
calling `store.product.brand.edit` with `enabled: false`.

Usage:
  python merge_moonys_zooties_into_moonys.py            # dry run
  python merge_moonys_zooties_into_moonys.py --apply    # live
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_ROOT = WORKDIR.parents[1]
SWEED_HELPER_DIR = AUTOMATION_ROOT / "bulk_additions" / "2026-04-10"

if str(SWEED_HELPER_DIR) not in sys.path:
    sys.path.insert(0, str(SWEED_HELPER_DIR))

import apply_product_catalog_attribute_updates as sweed  # noqa: E402

STATE_DEALER_ID = 210248
SOURCE_BRAND_ID = 16414  # "Moony's Zooties" (duplicate)
SOURCE_BRAND_NAME = "Moony's Zooties"
TARGET_BRAND_ID = 4408   # "Moony's" (canonical)
TARGET_BRAND_NAME = "Moony's"


def rename_zooties(text: str | None) -> str | None:
    if text is None:
        return None
    # Replace whole-word brand prefix only, leaves anything that does
    # not start with the duplicate brand untouched.
    if SOURCE_BRAND_NAME in text:
        return text.replace(SOURCE_BRAND_NAME, TARGET_BRAND_NAME)
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually apply changes; default is dry-run.",
    )
    args = parser.parse_args()
    dry_run = not args.apply

    print(f"Mode: {'APPLY (live writes)' if not dry_run else 'DRY RUN (no writes)'}")
    print(f"State dealer: {STATE_DEALER_ID}")
    sweed.api_call("store.auth.dealer.set", {"dealerId": STATE_DEALER_ID})

    # --- Sanity check brands ---
    brands = sweed.api_call(
        "store.product.brand.list", {"page": 1, "pageSize": 1000000}
    )
    brand_by_id = {b["id"]: b for b in brands}
    src = brand_by_id.get(SOURCE_BRAND_ID)
    tgt = brand_by_id.get(TARGET_BRAND_ID)
    if not src or src["name"] != SOURCE_BRAND_NAME:
        raise RuntimeError(
            f"Source brand {SOURCE_BRAND_ID} does not match name "
            f"`{SOURCE_BRAND_NAME}`: {src}"
        )
    if not tgt or tgt["name"] != TARGET_BRAND_NAME:
        raise RuntimeError(
            f"Target brand {TARGET_BRAND_ID} does not match name "
            f"`{TARGET_BRAND_NAME}`: {tgt}"
        )
    print(f"Source brand confirmed: {src}")
    print(f"Target brand confirmed: {tgt}")

    # --- Find every group under the duplicate brand ---
    groups_resp = sweed.api_call(
        "store.product.group.list",
        {"page": 1, "pageSize": 1000, "brandIds": [SOURCE_BRAND_ID]},
    )
    groups = groups_resp["data"]
    print(f"\nFound {len(groups)} product group(s) under `{SOURCE_BRAND_NAME}`.")

    results: list[dict] = []
    for summary in groups:
        group_id = summary["id"]
        group = sweed.api_call("store.product.group.get", {"id": group_id})
        before_image_ids = [img["id"] for img in (group.get("images") or [])]
        before_brand_id = (group.get("brand") or {}).get("id")
        before_brand_name = (group.get("brand") or {}).get("name")

        # Edit each product within the group.
        product_actions: list[dict] = []
        for prod_stub in group.get("products", []):
            product_id = int(prod_stub["id"])
            product = sweed.api_call(
                "store.product.get", {"id": str(product_id)}
            )["product"]
            new_name = rename_zooties(product.get("name"))
            new_short = rename_zooties(product.get("shortName"))
            edits: dict = {"id": product_id}
            if new_name and new_name != product.get("name"):
                edits["name"] = new_name
            if new_short and new_short != product.get("shortName"):
                edits["shortName"] = new_short
            edit_applied = False
            if len(edits) > 1:
                if not dry_run:
                    sweed.api_call("store.product.edit", edits)
                edit_applied = True
            product_actions.append(
                {
                    "productId": product_id,
                    "before": {
                        "name": product.get("name"),
                        "shortName": product.get("shortName"),
                    },
                    "afterPlanned": {
                        "name": new_name,
                        "shortName": new_short,
                    },
                    "editApplied": edit_applied and not dry_run,
                    "wouldEdit": edit_applied,
                }
            )

        # Edit the group itself: brand swap + image removal.
        group_edit = {
            "id": group_id,
            "brandId": TARGET_BRAND_ID,
            "imagesIds": [],
        }
        if not dry_run:
            sweed.api_call("store.product.group.edit", group_edit)
            group_after = sweed.api_call(
                "store.product.group.get", {"id": group_id}
            )
            after_brand_id = (group_after.get("brand") or {}).get("id")
            after_brand_name = (group_after.get("brand") or {}).get("name")
            after_image_ids = [img["id"] for img in (group_after.get("images") or [])]
        else:
            after_brand_id = TARGET_BRAND_ID
            after_brand_name = TARGET_BRAND_NAME
            after_image_ids = []

        result = {
            "groupId": group_id,
            "groupName": group.get("name"),
            "fullNameBefore": group.get("fullName"),
            "category": (group.get("category") or {}).get("name"),
            "subcategory": (group.get("subcategory") or {}).get("name"),
            "brandBefore": {"id": before_brand_id, "name": before_brand_name},
            "brandAfter": {"id": after_brand_id, "name": after_brand_name},
            "imageIdsBefore": before_image_ids,
            "imageIdsAfter": after_image_ids,
            "groupEditApplied": not dry_run,
            "products": product_actions,
        }
        print(
            f"  - group {group_id} `{group.get('fullName')}` "
            f"images={len(before_image_ids)}->{len(after_image_ids)} "
            f"brand={before_brand_id}->{after_brand_id} "
            f"products={len(product_actions)}"
        )
        results.append(result)

    # --- Disable duplicate brand last ---
    brand_edit_params = {"id": SOURCE_BRAND_ID, "enabled": False}
    brand_disable_applied = False
    brand_after = None
    if not dry_run:
        sweed.api_call("store.product.brand.edit", brand_edit_params)
        # Re-list to confirm.
        post = sweed.api_call(
            "store.product.brand.list", {"page": 1, "pageSize": 1000000}
        )
        brand_after = next(
            (b for b in post if b["id"] == SOURCE_BRAND_ID), None
        )
        brand_disable_applied = True
    print(
        f"\nBrand disable: {SOURCE_BRAND_NAME} (id={SOURCE_BRAND_ID}) "
        f"applied={brand_disable_applied} after={brand_after}"
    )

    out_path = WORKDIR / (
        "merge_results_apply.json" if not dry_run else "merge_results_dryrun.json"
    )
    out_path.write_text(
        json.dumps(
            {
                "mode": "apply" if not dry_run else "dryrun",
                "sourceBrand": {"id": SOURCE_BRAND_ID, "name": SOURCE_BRAND_NAME},
                "targetBrand": {"id": TARGET_BRAND_ID, "name": TARGET_BRAND_NAME},
                "groups": results,
                "brandDisable": {
                    "applied": brand_disable_applied,
                    "after": brand_after,
                },
            },
            indent=2,
        )
        + "\n"
    )
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
