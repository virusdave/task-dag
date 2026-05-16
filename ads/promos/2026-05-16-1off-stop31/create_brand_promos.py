#!/usr/bin/env python3
"""Create one Sweed promo action per distinct brand in purchase order
131845 (Stop 31 LLC), each granting 15% off everything from that brand,
all attached to the existing campaign "1Off" (id 13020,
GUID 9176347c-503f-413c-a53a-7f7eefb03cca).

Each promo:
  * applicationType  = Simple
  * actionType       = Percent discount
  * applicationTarget= Product   (discount applies to qualifying items)
  * applicationMode  = Regular   (stacks at the discount step)
  * discountPercent  = 15
  * one Get selector with a single rule: brandsIds == <brand>

Sweed treats the "Get" selector as the set of items the discount is
applied to. For Simple + Percent discount promos the Buy selector is
generally unused (it's a BOGO/Bundle concept); using one here just
hides the promo from the Sweed UI's "Discounted items" view.

The brand list is derived live from the order's positions (each position's
suggestedProduct -> product.get -> productGroup.get -> brand).

Run:
  python3 ads/promos/2026-05-16-1off-stop31/create_brand_promos.py        # dry run
  python3 ads/promos/2026-05-16-1off-stop31/create_brand_promos.py --apply
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import re
import sys
import uuid
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_DIR = WORKDIR.parents[2]
BULK_ADDITIONS_DIR = AUTOMATION_DIR / "bulk_additions" / "2026-04-10"
if str(BULK_ADDITIONS_DIR) not in sys.path:
    sys.path.insert(0, str(BULK_ADDITIONS_DIR))

import apply_product_catalog_attribute_updates as sweed

CAMPAIGN_ID = "13020"
CAMPAIGN_NAME = "1Off"
PURCHASE_ORDER_ID = 131845
SITE_DEALER_ID = 210705  # Freshly Baked NYC - Midtown (purchase is filed here)
DISCOUNT_PERCENT = 15.0
FROM_DATE_ISO = "2026-05-16T00:00:00Z"


def collect_distinct_brand_ids(order_id: int) -> list[dict]:
    sweed.api_call("store.auth.dealer.set", {"dealerId": SITE_DEALER_ID})
    order = sweed.api_call("store.purchase.order.get", {"id": order_id})

    product_ids: set[str] = set()
    for pos in order.get("positions") or []:
        suggested = pos.get("suggestedProduct") or (pos.get("distributorProduct") or {}).get("product")
        if suggested and suggested.get("id"):
            product_ids.add(str(suggested["id"]))

    sweed.switch_to_state_context()

    brands: dict[int, str] = {}
    group_cache: dict[int, dict] = {}
    for pid in sorted(product_ids):
        product = sweed.api_call("store.product.get", {"id": pid})["product"]
        gid = int(product["productGroupId"])
        if gid not in group_cache:
            group_cache[gid] = sweed.api_call("store.product.group.get", {"id": gid})
        group = group_cache[gid]
        brand = group.get("brand") or {}
        if brand.get("id"):
            brands.setdefault(int(brand["id"]), brand.get("name") or "")

    return [{"id": bid, "name": bname} for bid, bname in sorted(brands.items(), key=lambda kv: (kv[1] or "").lower())]


def brand_short_name(brand_name: str) -> str:
    # Sweed shortName has a ~16 char practical UI limit; keep it tight.
    # Do NOT prefix with the campaign name (e.g. "1Off") - the campaign
    # already provides that context in the UI.
    slug = re.sub(r"[^A-Za-z0-9]+", "", brand_name)
    return f"{slug}15"[:24]


def make_selector_data(brand_id: int, brand_name: str) -> str:
    payload = {
        "id": "__ROOT__",
        "root": True,
        "combinator": "and",
        "rules": [
            {
                "id": str(uuid.uuid4()),
                "new": True,
                "field": "brandsIds",
                "type": "multiSelect",
                "operator": "equal",
                "value": [{"id": brand_id, "name": brand_name}],
            }
        ],
        "touched": True,
    }
    return base64.b64encode(json.dumps(payload).encode()).decode()


def existing_action_for_brand(brand_id: int) -> dict | None:
    """Return any enabled action in this campaign whose get selector targets
    exactly this brand (so we don't double-create on re-runs). Disabled
    actions and disabled selectors are ignored."""
    page = 1
    while True:
        resp = sweed.api_call(
            "store.promo.action.list",
            {"page": page, "pageSize": 200, "campaignId": CAMPAIGN_ID},
        )
        data = resp.get("data") or []
        for action in data:
            if not action.get("enabled"):
                continue
            for selector in action.get("getSelectors") or []:
                if not selector.get("enabled"):
                    continue
                brands = selector.get("brands") or []
                if len(brands) == 1 and int(brands[0]["id"]) == brand_id:
                    return action
        if len(data) < 200:
            return None
        page += 1


def create_promo_for_brand(brand: dict) -> dict:
    name = f"{brand['name']} 15% off"
    short_name = brand_short_name(brand["name"])
    # Customer-facing: never include distributor name, PO number, cost,
    # or any other internal sourcing detail. Sweed surfaces this field
    # in ecommerce contexts. Keep it short and benefit-focused.
    description = f"15% off all {brand['name']} products."
    action = sweed.api_call(
        "store.promo.action.add",
        {
            "campaignId": CAMPAIGN_ID,
            "applicationStepId": 1,   # Discount
            "applicationTargetId": 1, # Product (qualifying items)
            "applicationModeId": 1,   # Regular
            "applicationTypeId": 1,   # Simple
            "actionTypeId": 1,        # Percent discount
            "name": name,
            "shortName": short_name,
            "description": description,
            "fromDate": FROM_DATE_ISO,
            "discountPercent": DISCOUNT_PERCENT,
            "discountAmounts": [{"buyValue": 0.01, "discountPercent": DISCOUNT_PERCENT}],
            "requirementTypeId": 1,   # Qty
        },
    )
    action_id = action["id"]
    selector = sweed.api_call(
        "store.promo.selector.get.add",
        {
            "actionId": action_id,
            "brandsIds": [brand["id"]],
            "applicationModeId": 2,    # Any product
            "distributionLevelId": 3,  # All stores
            "selectorData": make_selector_data(brand["id"], brand["name"]),
        },
    )
    return {"action": action, "getSelector": selector}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Actually create promo actions.")
    args = parser.parse_args()

    brands = collect_distinct_brand_ids(PURCHASE_ORDER_ID)
    print(f"Distinct brands in purchase {PURCHASE_ORDER_ID} ({len(brands)}):")
    for b in brands:
        print(f"  {b['id']:>5}  {b['name']}")

    # Re-enter site context for promo writes (campaign is owned by Midtown).
    sweed.api_call("store.auth.dealer.set", {"dealerId": SITE_DEALER_ID})

    results = []
    for brand in brands:
        existing = existing_action_for_brand(brand["id"])
        if existing:
            print(f"  ! {brand['name']}: existing action {existing['id']} ({existing.get('name')!r}) already targets this brand; skipping.")
            results.append({"brand": brand, "skippedExistingActionId": existing["id"]})
            continue
        if not args.apply:
            print(f"  + {brand['name']}: would create action and brand get-selector.")
            results.append({"brand": brand, "dryRun": True})
            continue
        created = create_promo_for_brand(brand)
        print(f"  + {brand['name']}: action {created['action']['id']} selector {created['getSelector']['id']}")
        results.append({"brand": brand, "created": created})

    if args.apply:
        out = WORKDIR / "create_brand_promos_results.json"
        out.write_text(
            json.dumps(
                {
                    "ranAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "campaignId": CAMPAIGN_ID,
                    "purchaseOrderId": PURCHASE_ORDER_ID,
                    "results": results,
                },
                indent=2,
                default=str,
            )
            + "\n"
        )
        print(f"\nWrote {out}")
    else:
        print("\nDry run — pass --apply to actually create promo actions.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
