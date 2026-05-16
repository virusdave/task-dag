#!/usr/bin/env python3
"""Add a distributor-product record for the Rove Slim Battery
variant under the in-house 'Freshly Baked NYC' distributor at cost
$0.00.

Background:
  - State-level catalog group 333828 / variant 432710 ('Rove Slim
    Battery', 'Each') was created in add_rove_slim_battery.py.
  - The user wants a distributor-product row that links the FB-as-
    distributor entity (distributor id 650) to that variant so future
    purchase/transfer flows can reference it.
  - Requested cost: $0.00. The standard Sweed/helios convention for
    a zero-cost distributor product is to create the distributor
    product row without calling store.distributor.product.price.add;
    existing FB-as-distributor rows (e.g. 338204, 371463-65) follow
    exactly this pattern and read back as price: 0.

Run:
  python3 catalog/additions/2026-05-16-rove-slim-battery/add_distributor_product.py            # dry run
  python3 catalog/additions/2026-05-16-rove-slim-battery/add_distributor_product.py --apply    # write to Sweed
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

FRESHLY_BAKED_NYC_DISTRIBUTOR_ID = 650
ROVE_SLIM_BATTERY_VARIANT_ID = 432710
DISTRIBUTOR_PRODUCT_NAME = "Rove Slim Battery Each"
PRODUCT_QTY = 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Actually write to Sweed.")
    args = parser.parse_args()

    sweed.switch_to_state_context()

    # Sanity: confirm no existing FB-distributor row already points
    # at this variant with the same name.
    existing = sweed.api_call(
        "store.distributor.product.list",
        {"page": 1, "pageSize": 1000, "productId": ROVE_SLIM_BATTERY_VARIANT_ID},
    )
    matches = []
    for dp in (existing.get("data") or []):
        dist = (dp.get("distributor") or {}).get("id")
        if dist == FRESHLY_BAKED_NYC_DISTRIBUTOR_ID:
            matches.append({"id": dp.get("id"), "name": dp.get("name"), "price": dp.get("price")})
    if matches:
        print("Found existing FB-distributor entries for variant 432710:")
        print(json.dumps(matches, indent=2))
        print("Skipping create.")
        return 0

    add_params = {
        "distributorId": FRESHLY_BAKED_NYC_DISTRIBUTOR_ID,
        "name": DISTRIBUTOR_PRODUCT_NAME,
        "productId": str(ROVE_SLIM_BATTERY_VARIANT_ID),
        "productQty": PRODUCT_QTY,
    }

    print("PLAN:")
    print("  store.distributor.product.add:")
    print(json.dumps(add_params, indent=4))
    print("\n  (cost = $0.00 -> no store.distributor.product.price.add call,")
    print("   matching existing FB-as-distributor zero-cost rows like 371463-65.)")

    if not args.apply:
        print("\nDry run - pass --apply to write to Sweed.")
        return 0

    print("\nApplying store.distributor.product.add...")
    created = sweed.api_call("store.distributor.product.add", add_params)
    new_id = created.get("id") if isinstance(created, dict) else created
    if isinstance(new_id, dict):
        new_id = new_id.get("id")
    print(f"  -> created distributor product id {new_id}")

    # readback via list
    readback = sweed.api_call(
        "store.distributor.product.list",
        {"page": 1, "pageSize": 1000, "productId": ROVE_SLIM_BATTERY_VARIANT_ID},
    )
    after = None
    for dp in (readback.get("data") or []):
        if dp.get("id") == new_id or str(dp.get("id")) == str(new_id):
            after = {
                "id": dp.get("id"),
                "name": dp.get("name"),
                "distributor": (dp.get("distributor") or {}).get("name"),
                "distributorId": (dp.get("distributor") or {}).get("id"),
                "price": dp.get("price"),
                "product": {
                    "id": (dp.get("product") or {}).get("id"),
                    "name": (dp.get("product") or {}).get("name"),
                },
            }
            break

    print("\nAFTER:")
    print(json.dumps(after, indent=2))

    results_path = WORKDIR / "add_distributor_product_results.json"
    existing_results = {}
    if results_path.exists():
        try:
            existing_results = json.loads(results_path.read_text())
        except Exception:
            existing_results = {}
    existing_results["distributorProductAdd"] = {
        "addParams": add_params,
        "createdId": new_id,
        "after": after,
    }
    results_path.write_text(json.dumps(existing_results, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {results_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
