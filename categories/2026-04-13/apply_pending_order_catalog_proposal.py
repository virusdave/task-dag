#!/usr/bin/env python3

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.request
from collections import Counter
from pathlib import Path


WORKDIR = Path(__file__).resolve().parent
AUTOMATION_DIR = WORKDIR.parents[1]
BULK_ADDITIONS_DIR = AUTOMATION_DIR / "bulk_additions" / "2026-04-10"
if str(BULK_ADDITIONS_DIR) not in sys.path:
    sys.path.insert(0, str(BULK_ADDITIONS_DIR))
if str(WORKDIR) not in sys.path:
    sys.path.insert(0, str(WORKDIR))

import apply_product_catalog_attribute_updates as sweed_attr
import generate_pending_order_catalog_proposal as proposal_generator


SITE_CONFIGS = {
    "midtown": {
        "dealerId": 210705,
        "dealerName": "Freshly Baked NYC - Midtown",
        "packetPath": WORKDIR / "pending_order_catalog_proposal.json",
        "resultsPath": WORKDIR / "pending_order_catalog_apply_results.json",
    },
    "bronx": {
        "dealerId": 210249,
        "dealerName": "Freshly Baked NYC - The Bronx",
        "packetPath": WORKDIR / "bronx_pending_order_catalog_proposal.json",
        "resultsPath": WORKDIR / "bronx_pending_order_catalog_apply_results.json",
    },
}

SITE_KEY = "midtown"
PACKET_PATH = SITE_CONFIGS[SITE_KEY]["packetPath"]
RESULTS_PATH = SITE_CONFIGS[SITE_KEY]["resultsPath"]

STATE_DEALER_ID = 210248
STATE_DEALER_NAME = "Freshly Baked NY"
SITE_DEALER_ID = SITE_CONFIGS[SITE_KEY]["dealerId"]
SITE_DEALER_NAME = SITE_CONFIGS[SITE_KEY]["dealerName"]
ALLOWED_SALE_TYPE_ID = 1


class RunError(RuntimeError):
    pass


def configure_runtime(site_key: str, packet_path: str | None = None, results_path: str | None = None) -> None:
    global SITE_KEY
    global SITE_DEALER_ID
    global SITE_DEALER_NAME
    global PACKET_PATH
    global RESULTS_PATH

    config = SITE_CONFIGS[site_key]
    SITE_KEY = site_key
    SITE_DEALER_ID = int(config["dealerId"])
    SITE_DEALER_NAME = str(config["dealerName"])
    PACKET_PATH = Path(packet_path) if packet_path else Path(config["packetPath"])
    RESULTS_PATH = Path(results_path) if results_path else Path(config["resultsPath"])


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def today_iso() -> str:
    return dt.date.today().isoformat()


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")


def lower_name_map(items: list[dict]) -> dict[str, dict]:
    return {item["name"].lower(): item for item in items}


def normalize_name(value: str | None) -> str:
    return (value or "").strip().lower()


def switch_context(dealer_id: int, expected_name: str) -> dict:
    response = sweed_attr.api_call("store.auth.dealer.set", {"dealerId": dealer_id})
    current_id = int(response["user"]["currentDealerId"])
    current_name = response["user"]["currentDealerName"]
    if current_id != dealer_id:
        raise RunError(f"Dealer switch failed: expected {dealer_id}, got {current_id} / {current_name}")
    if current_name != expected_name:
        raise RunError(f"Dealer switch mismatch: expected {expected_name!r}, got {current_name!r}")
    return response


def download_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"user-agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def upload_image(url: str) -> str | None:
    if not url or not url.strip():
        # No image attached - caller is expected to drop the resulting None
        # blob id from `imagesIds` so the new group is created image-less.
        # The 2026-05-11 packet uses this path for rows whose only available
        # imagery would have been a forbidden Dutchie stock photo.
        return None
    blob_id = sweed_attr.api_call("store.blob.add", {"type": "banner"})
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


def parse_variant_tab(tab: str) -> tuple[int, str]:
    match = re.fullmatch(r"(\d+)x\s+(.+)", tab.strip())
    if match:
        return int(match.group(1)), match.group(2).strip()
    return 1, tab.strip()


def fetch_exact_variant(name: str) -> dict | None:
    response = sweed_attr.api_call("store.product.list.short", {"page": 1, "pageSize": 100, "query": name})
    for row in response.get("data", []):
        if normalize_name(row.get("name")) == normalize_name(name):
            return row
    return None


def fetch_product(product_id: int | str) -> dict:
    last_error = None
    for _ in range(5):
        try:
            return sweed_attr.api_call("store.product.get", {"id": str(product_id)})["product"]
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(0.5)
    raise last_error


def fetch_group(group_id: int | str) -> dict:
    return sweed_attr.api_call("store.product.group.get", {"id": int(group_id)})


def fetch_exact_strain(name: str) -> dict | None:
    response = sweed_attr.api_call("store.product.strain.list", {"page": 1, "pageSize": 100, "query": name})
    for row in response.get("data", []):
        if normalize_name(row.get("name")) == normalize_name(name):
            return row
    return None


def retry_exact_lookup(fetcher, name: str, *, attempts: int = 5, delay_s: float = 0.5):
    for attempt in range(attempts):
        row = fetcher(name)
        if row:
            return row
        if attempt + 1 < attempts:
            time.sleep(delay_s)
    return None


def summarize_group(group: dict) -> dict:
    return {
        "id": int(group["id"]),
        "name": group.get("name"),
        "brand": (group.get("brand") or {}).get("name"),
        "category": (group.get("category") or {}).get("name"),
        "subcategory": (group.get("subcategory") or {}).get("name") or "",
        "strain": (group.get("strain") or {}).get("name"),
        "images": [{"id": item["id"], "url": item["url"]} for item in group.get("images", [])],
        "products": [
            {
                "id": int(item["id"]),
                "name": item["name"],
                "tab": item.get("tab"),
                "price": item.get("price"),
            }
            for item in group.get("products", [])
        ],
    }


def summarize_product(product: dict) -> dict:
    return {
        "id": int(product["id"]),
        "name": product.get("name"),
        "shortName": product.get("shortName"),
        "tab": product.get("tab"),
        "price": product.get("price"),
        "productGroupId": int(product["productGroupId"]),
        "packOfSize": product.get("packOfSize"),
        "displayInEcommerce": product.get("displayInEcommerce"),
        "isPacked": product.get("isPacked"),
        "allowedSaleType": (product.get("allowedSaleType") or {}).get("name"),
        "size": (product.get("size") or {}).get("name"),
    }


def ensure_brand(name: str, brand_by_name: dict[str, dict], created_brands: list[dict]) -> dict:
    key = normalize_name(name)
    row = brand_by_name.get(key)
    if row:
        return row
    try:
        row = sweed_attr.api_call("store.product.brand.add", {"name": name})
    except Exception:
        brands = sweed_attr.api_call("store.product.brand.list", {"page": 1, "pageSize": 1000000})
        row = lower_name_map(brands).get(key)
        if not row:
            raise
    else:
        created_brands.append({"id": int(row["id"]), "name": row["name"]})
    brand_by_name[key] = row
    return row


def ensure_target_strain(
    name: str,
    prevalence_name: str,
    strains_by_name: dict[str, dict],
    prevalence_by_name: dict[str, dict],
    created_strains: list[dict],
) -> dict | None:
    if not name:
        return None
    key = normalize_name(name)
    existing = strains_by_name.get(key) or retry_exact_lookup(fetch_exact_strain, name, attempts=2, delay_s=0.25)
    if existing:
        strains_by_name[key] = existing
        return existing
    if not prevalence_name:
        return None
    prevalence = prevalence_by_name.get(normalize_name(prevalence_name))
    if not prevalence:
        raise RunError(f"Missing prevalence `{prevalence_name}` for strain `{name}`")
    try:
        sweed_attr.api_call(
            "store.product.strain.add",
            {
                "name": name,
                "prevalenceId": int(prevalence["id"]),
            },
        )
    except Exception:
        existing = retry_exact_lookup(fetch_exact_strain, name)
        if not existing:
            raise
    else:
        existing = retry_exact_lookup(fetch_exact_strain, name)
    if not existing:
        raise RunError(f"Unable to resolve strain after create: {name}")
    strains_by_name[key] = existing
    created_strains.append({"id": int(existing["id"]), "name": existing["name"]})
    return existing


def find_existing_group_for_row(row: dict) -> dict | None:
    response = sweed_attr.api_call("store.product.list.short", {"page": 1, "pageSize": 100, "query": row["targetGroupName"]})
    matches = []
    for item in response.get("data", []):
        product = fetch_product(int(item["id"]))
        group = fetch_group(int(product["productGroupId"]))
        if normalize_name(group.get("name")) != normalize_name(row["targetGroupName"]):
            continue
        if normalize_name((group.get("brand") or {}).get("name")) != normalize_name(row["targetBrand"]):
            continue
        if (group.get("category") or {}).get("name") != row["expectedCategory"]:
            continue
        if ((group.get("subcategory") or {}).get("name") or "") != row["expectedSubcategory"]:
            continue
        matches.append(
            {
                "group": group,
                "product": product,
            }
        )
    if not matches:
        return None
    matches.sort(key=lambda item: int(item["product"]["id"]))
    return matches[0]


def ensure_product_state(product: dict, row: dict, size_id: int, pack_count: int) -> dict:
    before = summarize_product(product)
    edit_params = {"id": int(product["id"])}
    if product.get("name") != row["targetVariantName"]:
        edit_params["name"] = row["targetVariantName"]
    if product.get("shortName") != row["targetVariantName"]:
        edit_params["shortName"] = row["targetVariantName"]
    if product.get("price") != row["proposedPrice"]:
        edit_params["price"] = row["proposedPrice"]
    if product.get("tab") != row["targetVariantTab"]:
        edit_params["tab"] = row["targetVariantTab"]
    if int(product.get("packOfSize") or 1) != pack_count:
        edit_params["packOfSize"] = pack_count
    if int((product.get("size") or {}).get("id") or 0) != size_id:
        edit_params["sizeId"] = size_id
    if int((product.get("allowedSaleType") or {}).get("id") or 0) != ALLOWED_SALE_TYPE_ID:
        edit_params["allowedSaleTypeId"] = ALLOWED_SALE_TYPE_ID
    if not product.get("displayInEcommerce"):
        edit_params["displayInEcommerce"] = True
    if not product.get("isPacked"):
        edit_params["isPacked"] = True

    edit_applied = len(edit_params) > 1
    if edit_applied:
        sweed_attr.api_call("store.product.edit", edit_params)
        product = fetch_product(int(product["id"]))
    return {
        "before": before,
        "after": summarize_product(product),
        "editApplied": edit_applied,
        "editParams": edit_params if edit_applied else None,
    }


def ensure_distributor_link(row: dict, product_id: int, distributor_id: int) -> dict:
    existing = sweed_attr.api_call(
        "store.distributor.product.list",
        {"page": 1, "pageSize": 1000000, "productId": product_id},
    )
    for item in existing.get("data", []):
        if int((item.get("distributor") or {}).get("id") or 0) != distributor_id:
            continue
        if normalize_name(item.get("name")) != normalize_name(row["distributorProductName"]):
            continue
        return {
            "created": False,
            "priceAdded": False,
            "priceSkippedReason": None,
            "distributorProduct": item,
        }

    created = sweed_attr.api_call(
        "store.distributor.product.add",
        {
            "distributorId": distributor_id,
            "name": row["distributorProductName"],
            "productQty": 1,
            "productId": str(product_id),
        },
    )

    if row["effectiveUnitCost"] is None:
        return {
            "created": True,
            "priceAdded": False,
            "priceSkippedReason": "missing-effective-unit-cost",
            "distributorProduct": created,
        }

    sweed_attr.api_call(
        "store.distributor.product.price.add",
        {
            "distributorProductId": str(created["id"]),
            "fromDate": today_iso(),
            "distributorProductPrice": row["effectiveUnitCost"],
        },
    )
    return {
        "created": True,
        "priceAdded": True,
        "priceSkippedReason": None,
        "distributorProduct": created,
    }


def load_packet_rows() -> list[dict]:
    packet = json.loads(PACKET_PATH.read_text())
    rows = list(packet.get("rows") or [])
    rows.sort(key=lambda row: (min(row["orderIds"]), row["distributorProductId"]))
    return rows


def validate_packet_context(packet: dict) -> None:
    site_context = packet.get("siteContext") or {}
    packet_dealer_id = int(site_context.get("dealerId") or 0)
    packet_dealer_name = site_context.get("dealerName") or ""
    if packet_dealer_id != SITE_DEALER_ID:
        raise RunError(
            f"Packet dealer mismatch: runtime expects {SITE_DEALER_ID}, packet carries {packet_dealer_id}"
        )
    if packet_dealer_name != SITE_DEALER_NAME:
        raise RunError(
            f"Packet dealer mismatch: runtime expects {SITE_DEALER_NAME!r}, packet carries {packet_dealer_name!r}"
        )


def load_order_context(rows: list[dict]) -> dict[int, dict]:
    order_context = {}
    switch_context(SITE_DEALER_ID, SITE_DEALER_NAME)
    for order_id in sorted({order_id for row in rows for order_id in row["orderIds"]}):
        order = sweed_attr.api_call("store.purchase.order.get", {"id": order_id})
        order_context[order_id] = {
            "orderId": order_id,
            "distributorId": int((order.get("distributor") or {}).get("id") or 0),
            "distributorName": (order.get("distributor") or {}).get("name") or "",
        }
    return order_context


def distributor_context_for_row(row: dict, order_context: dict[int, dict]) -> dict:
    contexts = [order_context[order_id] for order_id in row["orderIds"]]
    distributor_ids = {context["distributorId"] for context in contexts}
    if len(distributor_ids) != 1:
        raise RunError(f"Row {row['distributorProductId']} spans multiple distributors: {sorted(distributor_ids)}")
    return contexts[0]


def ensure_row(row: dict, lookups: dict, created: dict[str, list[dict]], order_context: dict[int, dict]) -> dict:
    pack_count, size_name = parse_variant_tab(row["targetVariantTab"])
    size_row = lookups["sizeByName"].get(normalize_name(size_name))
    if not size_row:
        raise RunError(f"Missing size `{size_name}` for {row['targetVariantName']}")

    brand_row = ensure_brand(row["targetBrand"], lookups["brandByName"], created["brands"])
    category_row = lookups["categoryByName"].get(normalize_name(row["expectedCategory"]))
    if not category_row:
        raise RunError(f"Missing category `{row['expectedCategory']}`")

    subcategory_row = None
    if row["expectedSubcategory"]:
        subcategory_row = next(
            (
                item
                for item in category_row.get("subcategories", [])
                if normalize_name(item.get("name")) == normalize_name(row["expectedSubcategory"])
            ),
            None,
        )
        if not subcategory_row:
            raise RunError(
                f"Missing subcategory `{row['expectedSubcategory']}` under `{row['expectedCategory']}`"
            )

    exact_variant = fetch_exact_variant(row["targetVariantName"])
    existing_group_match = None
    created_blob_id = None
    created_group_id = None
    created_product_id = None

    if exact_variant:
        final_product = fetch_product(int(exact_variant["id"]))
        existing_group = fetch_group(int(final_product["productGroupId"]))
        existing_category = (existing_group.get("category") or {}).get("name") or ""
        existing_subcategory = (existing_group.get("subcategory") or {}).get("name") or ""
        # Hard-stop if the variant name collides with a live product whose
        # group is in a different category/subcategory than what the proposal
        # expected. Silently reusing the existing group is what caused
        # product 376985 ("Herb Sour Diesel 1g") to be miscategorised as a
        # Pre-Roll when it was really a 1g All-In-One vape on 2026-05-13.
        # Forcing a loud failure here means the operator must either
        # (a) rename the new variant so it doesn't collide, or
        # (b) re-categorise the existing group up-front, before re-running.
        if existing_category != row["expectedCategory"] or existing_subcategory != (row["expectedSubcategory"] or ""):
            raise RunError(
                "Exact-variant reuse refused: variant name "
                f"{row['targetVariantName']!r} matches live product "
                f"{int(exact_variant['id'])} whose group "
                f"{int(existing_group['id'])} is in "
                f"{existing_category!r}/{existing_subcategory!r}, but the "
                f"proposal expected "
                f"{row['expectedCategory']!r}/{row['expectedSubcategory'] or ''!r}. "
                "Rename the new variant or re-categorise the existing group "
                "before re-running."
            )
        group_source = "exact-variant"
        group_before = summarize_group(existing_group)
    else:
        existing_group_match = find_existing_group_for_row(row)
        if existing_group_match:
            group_id = int(existing_group_match["group"]["id"])
            product_result = sweed_attr.api_call(
                "store.product.add",
                {
                    "displayInEcommerce": True,
                    "isPacked": True,
                    "packOfSize": pack_count,
                    "allowedSaleTypeId": ALLOWED_SALE_TYPE_ID,
                    "sizeId": int(size_row["id"]),
                    "tab": row["targetVariantTab"],
                    "productGroupId": group_id,
                    "price": row["proposedPrice"],
                },
            )
            created_product_id = int(product_result["id"])
            final_product = fetch_product(created_product_id)
            group_source = "existing-group"
            group_before = summarize_group(existing_group_match["group"])
        else:
            target_strain = ensure_target_strain(
                row["targetStrain"],
                row["targetPrevalence"],
                lookups["strainsByName"],
                lookups["prevalenceByName"],
                created["strains"],
            )
            created_blob_id = upload_image(row["primaryImageUrl"])
            images_ids = [blob for blob in [created_blob_id] if blob]
            group_params = {
                "name": row["targetGroupName"],
                "brandId": int(brand_row["id"]),
                "description": "",
                "imagesIds": images_ids,
                "isFinishedProduct": True,
                "categoryId": int(category_row["id"]),
                "effectIds": [],
                "flavoringIds": [],
                "scentIds": [],
            }
            if subcategory_row:
                group_params["subcategoryId"] = int(subcategory_row["id"])
            if target_strain:
                group_params["strainId"] = int(target_strain["id"])
            group_result = sweed_attr.api_call("store.product.group.add", group_params)
            created_group_id = int(group_result["id"])
            product_result = sweed_attr.api_call(
                "store.product.add",
                {
                    "displayInEcommerce": True,
                    "isPacked": True,
                    "packOfSize": pack_count,
                    "allowedSaleTypeId": ALLOWED_SALE_TYPE_ID,
                    "sizeId": int(size_row["id"]),
                    "tab": row["targetVariantTab"],
                    "productGroupId": created_group_id,
                    "price": row["proposedPrice"],
                },
            )
            created_product_id = int(product_result["id"])
            final_product = fetch_product(created_product_id)
            group_source = "new-group"
            group_before = None

    product_update = ensure_product_state(final_product, row, int(size_row["id"]), pack_count)
    final_product = fetch_product(int(product_update["after"]["id"]))
    final_group = fetch_group(int(final_product["productGroupId"]))
    distributor_context = distributor_context_for_row(row, order_context)
    link_result = ensure_distributor_link(row, int(final_product["id"]), distributor_context["distributorId"])

    return {
        "distributorProductId": row["distributorProductId"],
        "distributorProductName": row["distributorProductName"],
        "actionType": row["actionType"],
        "targetVariantName": row["targetVariantName"],
        "targetGroupName": row["targetGroupName"],
        "targetBrand": row["targetBrand"],
        "targetStrain": row["targetStrain"],
        "targetPrevalence": row["targetPrevalence"],
        "targetVariantTab": row["targetVariantTab"],
        "proposedPrice": row["proposedPrice"],
        "effectiveUnitCost": row["effectiveUnitCost"],
        "orderIds": row["orderIds"],
        "positionIds": row["positionIds"],
        "reviewFlags": row["reviewFlags"],
        "groupSource": group_source,
        "brand": {"id": int(brand_row["id"]), "name": brand_row["name"]},
        "size": {"id": int(size_row["id"]), "name": size_row["name"]},
        "packCount": pack_count,
        "createdBlobId": created_blob_id,
        "createdGroupId": created_group_id,
        "createdProductId": created_product_id,
        "groupBefore": group_before,
        "groupAfter": summarize_group(final_group),
        "productUpdate": product_update,
        "distributor": distributor_context,
        "distributorLink": link_result,
    }


def verify_orders(rows: list[dict]) -> dict:
    position_ids_by_order: dict[int, set[int]] = {}
    for row in rows:
        for order_id in row["orderIds"]:
            position_ids_by_order.setdefault(order_id, set()).update(int(position_id) for position_id in row["positionIds"])

    verification = {}
    switch_context(SITE_DEALER_ID, SITE_DEALER_NAME)
    for order_id in sorted(position_ids_by_order):
        order = sweed_attr.api_call("store.purchase.order.get", {"id": order_id})
        suggestion = sweed_attr.api_call("store.distributor.product.suggestion", {"orderId": order_id})
        suggestion_map = {
            int(item["orderPositionId"]): {
                "suggestedProductCount": len(item.get("products") or []),
                "products": [
                    {
                        "id": int((product.get("product") or product).get("id")),
                        "name": (product.get("product") or product).get("name"),
                        "score": product.get("score"),
                        "isSuggestion": product.get("isSuggestion"),
                    }
                    for product in item.get("products") or []
                ],
            }
            for item in suggestion.get("orderPositions", [])
        }
        target_positions = sorted(position_ids_by_order[order_id])
        verification[str(order_id)] = {
            "purchaseOrderPositionCount": len(order.get("positions", [])),
            "targetPositionIds": target_positions,
            "targetSuggestions": {
                str(position_id): suggestion_map.get(position_id, {"suggestedProductCount": 0, "products": []})
                for position_id in target_positions
            },
            "unresolvedTargetPositionIds": [
                position_id
                for position_id in target_positions
                if not suggestion_map.get(position_id, {}).get("products")
            ],
        }
    return verification


def regenerate_packet(results: dict) -> dict:
    switch_context(SITE_DEALER_ID, SITE_DEALER_NAME)
    proposal_generator.configure_runtime(SITE_KEY, PACKET_PATH.stem)
    proposal_generator.cache = proposal_generator.CatalogCache()
    orders, groups = proposal_generator.collect_pending_groups()
    switch_context(STATE_DEALER_ID, STATE_DEALER_NAME)
    rows = [proposal_generator.build_row(group) for group in groups]
    payload = {
        "packetTitle": proposal_generator.PACKET_TITLE,
        "generatedAt": now_iso(),
        "siteContext": {
            "siteKey": SITE_KEY,
            "siteLabel": proposal_generator.SITE_LABEL,
            "dealerId": SITE_DEALER_ID,
            "dealerName": SITE_DEALER_NAME,
        },
        "stateContext": {"dealerId": STATE_DEALER_ID, "dealerName": STATE_DEALER_NAME},
        "orders": orders,
        "rows": rows,
    }
    proposal_generator.write_outputs(payload)
    packet = json.loads(PACKET_PATH.read_text())
    rows = list(packet.get("rows") or [])
    return {
        "generatedAt": packet.get("generatedAt"),
        "rowCount": len(rows),
        "actionTypeCounts": dict(Counter(row["actionType"] for row in rows)),
        "catalogCreateDistributorProductIds": [
            row["distributorProductId"] for row in rows if row["actionType"] == "catalog-create"
        ],
        "mappingOnlyDistributorProductIds": [
            row["distributorProductId"] for row in rows if row["actionType"] == "mapping-only"
        ],
        "rowsWithThinEvidence": [
            row["distributorProductId"]
            for row in rows
            if "Thin Lit Alerts evidence" in (row.get("reviewFlags") or [])
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply an approved pending-order catalog proposal packet.")
    parser.add_argument(
        "--site",
        choices=sorted(SITE_CONFIGS),
        default="midtown",
        help="Proposal site to apply. This selects both the packet path and the site dealer context unless overridden.",
    )
    parser.add_argument(
        "--packet",
        help="Optional path to the locked proposal JSON to apply.",
    )
    parser.add_argument(
        "--results",
        help="Optional path for the apply results JSON.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    configure_runtime(args.site, args.packet, args.results)
    packet = json.loads(PACKET_PATH.read_text())
    validate_packet_context(packet)
    rows = load_packet_rows()
    order_context = load_order_context(rows)
    results = {
        "startedAt": now_iso(),
        "siteKey": SITE_KEY,
        "packetPath": str(PACKET_PATH),
        "packetGeneratedAt": packet.get("generatedAt"),
        "stateContext": {"dealerId": STATE_DEALER_ID, "dealerName": STATE_DEALER_NAME},
        "siteContext": {"dealerId": SITE_DEALER_ID, "dealerName": SITE_DEALER_NAME},
        "approvedRowCount": len(rows),
        "created": {
            "brands": [],
            "strains": [],
        },
        "rows": [],
    }
    write_json(RESULTS_PATH, results)

    switch_context(STATE_DEALER_ID, STATE_DEALER_NAME)
    lookups = {
        "brandByName": lower_name_map(sweed_attr.api_call("store.product.brand.list", {"page": 1, "pageSize": 1000000})),
        "categoryByName": lower_name_map(sweed_attr.api_call("store.product.category.list", {})),
        "sizeByName": lower_name_map(sweed_attr.api_call("store.product.size.list", {})),
        "strainsByName": sweed_attr.fetch_all_strains(),
        "prevalenceByName": lower_name_map(sweed_attr.api_call("store.product.strain.prevalence.list", {})),
    }
    results["preloadedAt"] = now_iso()
    write_json(RESULTS_PATH, results)

    for row in rows:
        switch_context(STATE_DEALER_ID, STATE_DEALER_NAME)
        row_result = ensure_row(row, lookups, results["created"], order_context)
        results["rows"].append(row_result)
        write_json(RESULTS_PATH, results)

    results["summary"] = {
        "createdBrandCount": len(results["created"]["brands"]),
        "createdStrainCount": len(results["created"]["strains"]),
        "createdGroupCount": sum(1 for row in results["rows"] if row.get("createdGroupId")),
        "createdProductCount": sum(1 for row in results["rows"] if row.get("createdProductId")),
        "exactVariantReuseCount": sum(1 for row in results["rows"] if row["groupSource"] == "exact-variant"),
        "existingGroupReuseCount": sum(1 for row in results["rows"] if row["groupSource"] == "existing-group"),
        "newGroupCount": sum(1 for row in results["rows"] if row["groupSource"] == "new-group"),
        "createdDistributorLinkCount": sum(1 for row in results["rows"] if row["distributorLink"]["created"]),
        "skippedDistributorPriceCount": sum(
            1 for row in results["rows"] if row["distributorLink"].get("priceSkippedReason")
        ),
    }
    write_json(RESULTS_PATH, results)

    results["postWriteVerification"] = verify_orders(rows)
    write_json(RESULTS_PATH, results)

    results["postRegeneration"] = regenerate_packet(results)
    results["completedAt"] = now_iso()
    write_json(RESULTS_PATH, results)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
