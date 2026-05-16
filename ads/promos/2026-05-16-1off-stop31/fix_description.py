#!/usr/bin/env python3
"""Re-set the customer-facing description on promo action 44901 to the
canonical brand-list form derived from its live get selector.

The description was accidentally cleared. The selector itself is intact,
so this script reads brands straight from the selector instead of from
the purchase order, which keeps it idempotent and accurate even if the
brand set evolves.

Customer-facing rule: never include distributor name, PO number, cost,
or any other internal sourcing data.

Run:
  python3 ads/promos/2026-05-16-1off-stop31/fix_description.py            # dry run
  python3 ads/promos/2026-05-16-1off-stop31/fix_description.py --apply
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_DIR = WORKDIR.parents[2]
BULK_ADDITIONS_DIR = AUTOMATION_DIR / "bulk_additions" / "2026-04-10"
if str(BULK_ADDITIONS_DIR) not in sys.path:
    sys.path.insert(0, str(BULK_ADDITIONS_DIR))

import apply_product_catalog_attribute_updates as sweed

ACTION_ID = "44901"
SITE_DEALER_ID = 210705  # Midtown - where the campaign lives
DESCRIPTION_PREFIX = "15% off all featured 1Off brands:"


def build_description(brand_names: list[str]) -> str:
    return f"{DESCRIPTION_PREFIX} " + ", ".join(sorted(brand_names, key=str.lower)) + "."


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Actually write the description.")
    args = parser.parse_args()

    sweed.api_call("store.auth.dealer.set", {"dealerId": SITE_DEALER_ID})
    action = sweed.api_call("store.promo.action.get", {"id": ACTION_ID})

    selectors = [s for s in (action.get("getSelectors") or []) if s.get("enabled")]
    if len(selectors) != 1:
        print(
            f"  ! action {ACTION_ID} has {len(selectors)} enabled get selectors; expected exactly 1.",
            file=sys.stderr,
        )
        return 1
    selector = selectors[0]
    brand_names = [b.get("name") for b in (selector.get("brands") or []) if b.get("name")]
    if not brand_names:
        print(f"  ! action {ACTION_ID} selector has no brands; refusing to write empty description.", file=sys.stderr)
        return 1

    new_description = build_description(brand_names)
    current_description = action.get("description") or ""

    print(f"action: {ACTION_ID} - {action.get('name')!r}")
    print(f"  brands ({len(brand_names)}): {', '.join(sorted(brand_names, key=str.lower))}")
    print(f"  current description: {current_description!r}")
    print(f"  desired description: {new_description!r}")

    if current_description == new_description:
        print("\n  = description is already correct; nothing to do.")
        return 0

    if not args.apply:
        print("\nDry run - pass --apply to write the new description.")
        return 0

    sweed.api_call(
        "store.promo.action.edit",
        {"id": ACTION_ID, "description": new_description},
    )

    after = sweed.api_call("store.promo.action.get", {"id": ACTION_ID})
    after_description = after.get("description") or ""
    print(f"\n  + wrote description: {after_description!r}")
    if after_description != new_description:
        print("  ! readback does not match what we wrote.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
