#!/usr/bin/env python3
"""Create a single consolidated Sweed promo action that grants 15% off
every product from any of the distinct brands present in purchase order
131845 (Stop 31 LLC), attached to the existing campaign "1Off" (id
13020, GUID 9176347c-503f-413c-a53a-7f7eefb03cca).

Shape of the promo:
  * applicationType  = Simple
  * actionType       = Percent discount
  * applicationTarget= Product   (discount applies to qualifying items)
  * applicationMode  = Regular   (stacks at the discount step)
  * discountPercent  = 15
  * exactly one Get selector whose single rule is
    `brandsIds IN [<every brand from the PO>]`

Sweed uses the "Get" selector to define the items the discount is
applied to. The Buy selector is a BOGO/Bundle concept and should not
be used for Simple + Percent promos (it just hides the brand filter
from the "Discounted items" view).

Customer-facing fields (name, description) must never leak distributor
name, PO number, cost, or any other internal sourcing data - Sweed
surfaces them in the e-commerce UI.

Run:
  python3 ads/promos/2026-05-16-1off-stop31/create_brand_promos.py        # dry run
  python3 ads/promos/2026-05-16-1off-stop31/create_brand_promos.py --apply
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
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
PROMO_NAME = "1Off Brands 15% Off"
PROMO_SHORT_NAME = "1OffBrands15%"
# Customer-facing. The brand list itself is appended by build_description()
# from the live brand set (case-insensitive alphabetical) so it always
# matches the actual selector.
PROMO_DESCRIPTION_PREFIX = "15% off all featured 1Off brands:"


def build_description(brands: list[dict]) -> str:
    names = sorted([b["name"] for b in brands], key=str.lower)
    return f"{PROMO_DESCRIPTION_PREFIX} " + ", ".join(names) + "."


def collect_distinct_brands(order_id: int) -> list[dict]:
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


def make_selector_data(brands: list[dict]) -> str:
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
                "value": [{"id": b["id"], "name": b["name"]} for b in brands],
            }
        ],
        "touched": True,
    }
    return base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()


def existing_consolidated_action(brand_ids: set[int]) -> dict | None:
    """Return any enabled action in the campaign whose lone get selector
    targets exactly this brand set (so re-runs are idempotent)."""
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
            get_selectors = [s for s in (action.get("getSelectors") or []) if s.get("enabled")]
            if len(get_selectors) != 1:
                continue
            sel_brand_ids = {int(b["id"]) for b in (get_selectors[0].get("brands") or [])}
            if sel_brand_ids == brand_ids:
                return action
        if len(data) < 200:
            return None
        page += 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Actually create the promo action.")
    args = parser.parse_args()

    brands = collect_distinct_brands(PURCHASE_ORDER_ID)
    print(f"Distinct brands in purchase {PURCHASE_ORDER_ID} ({len(brands)}):")
    for b in brands:
        print(f"  {b['id']:>5}  {b['name']}")

    sweed.api_call("store.auth.dealer.set", {"dealerId": SITE_DEALER_ID})

    brand_ids = {b["id"] for b in brands}
    existing = existing_consolidated_action(brand_ids)
    if existing:
        print(
            f"\n  ! Enabled action {existing['id']} ({existing.get('name')!r}) "
            "already covers exactly this brand set; nothing to do."
        )
        return 0

    if not args.apply:
        print(
            f"\n  + would create action {PROMO_NAME!r} in campaign {CAMPAIGN_ID} "
            f"with one get selector matching brandsIds IN {sorted(brand_ids)}."
        )
        print("\nDry run — pass --apply to write.")
        return 0

    action = sweed.api_call(
        "store.promo.action.add",
        {
            "campaignId": CAMPAIGN_ID,
            "applicationStepId": 1,    # Discount
            "applicationTargetId": 1,  # Product
            "applicationModeId": 1,    # Regular
            "applicationTypeId": 1,    # Simple
            "actionTypeId": 1,         # Percent discount
            "name": PROMO_NAME,
            "shortName": PROMO_SHORT_NAME,
            "description": build_description(brands),
            "fromDate": FROM_DATE_ISO,
            "discountPercent": DISCOUNT_PERCENT,
            "discountAmounts": [{"buyValue": 0.01, "discountPercent": DISCOUNT_PERCENT}],
            "requirementTypeId": 1,    # Qty
        },
    )
    selector = sweed.api_call(
        "store.promo.selector.get.add",
        {
            "actionId": action["id"],
            "brandsIds": [b["id"] for b in brands],
            "applicationModeId": 2,    # Any product
            "distributionLevelId": 3,  # All stores
            "selectorData": make_selector_data(brands),
        },
    )
    print(
        f"\n  + created action {action['id']} {PROMO_NAME!r} with get selector "
        f"{selector['id']} (productCount={selector.get('productCount')})"
    )

    out = WORKDIR / "create_brand_promos_results.json"
    out.write_text(
        json.dumps(
            {
                "ranAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "campaignId": CAMPAIGN_ID,
                "purchaseOrderId": PURCHASE_ORDER_ID,
                "brands": brands,
                "action": action,
                "getSelector": selector,
            },
            indent=2,
            default=str,
        )
        + "\n"
    )
    print(f"\nWrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
