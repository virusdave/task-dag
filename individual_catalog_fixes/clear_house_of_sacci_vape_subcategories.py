#!/usr/bin/env python3
"""Clear the catalog subcategory on every in-stock House of Sacci vape group.

House of Sacci only sells 510 cartridges in this workspace right now, but their
live catalog rows have inherited the `Vapes / Cartridge` (or worse) subcategory.
Per `docs/sweed/catalog/creation-and-editing.md`, marking a non-AIO row as AIO is
much worse than leaving the subcategory blank, so we clear the subcategory on
every in-stock group instead of trusting any inherited label.

Usage:
    python clear_house_of_sacci_vape_subcategories.py            # dry-run
    python clear_house_of_sacci_vape_subcategories.py --apply    # writes
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any


API_URL = "https://prime.sweedpos.com/api/"
WORKDIR = Path(__file__).resolve().parent
DEFAULT_AUTH_TOKEN_PATH = Path("/Users/amp-local/.secret/sweed/auth-token")
RESULTS_PATH = WORKDIR / "house_of_sacci_vape_subcategory_clear_results.json"
STATE_DEALER_ID = 210248
STATE_DEALER_NAME = "Freshly Baked NY"
SITES = [
    {"dealerId": 210249, "dealerName": "Freshly Baked NYC - The Bronx"},
    {"dealerId": 210705, "dealerName": "Freshly Baked NYC - Midtown"},
]
TARGET_BRAND = "House of Sacci"
TARGET_CATEGORY = "Vapes"
INVENTORY_PAGE_SIZE = 100
VERIFY_POLL_ATTEMPTS = 6
VERIFY_POLL_DELAY_SECONDS = 0.5


class RunError(RuntimeError):
    pass


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def progress(message: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def rpc(auth: str, name: str, params: dict[str, Any] | None = None, *, timeout: int = 120) -> Any:
    payload: dict[str, Any] = {"auth": auth, "name": name, "id": str(uuid.uuid4())}
    if params is not None:
        payload["params"] = params
    proc = subprocess.run(
        ["curl", "-4", "-sS", API_URL, "-H", "content-type: application/json", "--data-binary", "@-"],
        input=json.dumps(payload).encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RunError(proc.stderr.decode() or f"curl exited {proc.returncode}")
    text = proc.stdout.decode()
    try:
        body = json.loads(text)
    except Exception as exc:
        raise RunError(f"Non-JSON response from {name}: {text[:500]!r}") from exc
    if "error" in body:
        raise RunError(f"{name} failed: {json.dumps(body['error'], sort_keys=True)}")
    if isinstance(body.get("result"), dict) and "error" in body["result"]:
        raise RunError(f"{name} failed: {json.dumps(body['result']['error'], sort_keys=True)}")
    return body.get("result")


def switch_dealer(auth: str, dealer_id: int, dealer_name: str) -> None:
    result = rpc(auth, "store.auth.dealer.set", {"dealerId": dealer_id}) or {}
    user = result.get("user") or {}
    current_id = int(user.get("currentDealerId") or 0)
    current_name = user.get("currentDealerName")
    if current_id != dealer_id or current_name != dealer_name:
        raise RunError(
            f"Dealer switch failed: expected {dealer_id} / {dealer_name!r}, "
            f"got {current_id} / {current_name!r}"
        )


def fetch_in_stock_house_of_sacci_vape_products(auth: str) -> dict[int, dict[str, Any]]:
    """Return {productId -> {productName, sites: [siteName,...], observedSubcategory{Name,Id}}}.

    `store.inventory.item.list.grouped` rows only carry the variant `product`,
    `productBrand`, `category`, and `subcategory` (no `productGroup`). We resolve
    the parent product group later from the state catalog.
    """
    by_product: dict[int, dict[str, Any]] = {}
    for site in SITES:
        progress(f"Pulling in-stock inventory at {site['dealerName']} ({site['dealerId']})")
        switch_dealer(auth, site["dealerId"], site["dealerName"])
        page = 1
        site_match_count = 0
        while True:
            response = rpc(
                auth,
                "store.inventory.item.list.grouped",
                {"page": page, "pageSize": INVENTORY_PAGE_SIZE, "isOnStock": True},
            ) or {}
            data = response.get("data") or []
            for row in data:
                brand = (row.get("productBrand") or row.get("brand") or {}).get("name") or ""
                category = (row.get("category") or {}).get("name") or ""
                if brand.strip().lower() != TARGET_BRAND.lower():
                    continue
                if category.strip().lower() != TARGET_CATEGORY.lower():
                    continue
                product = row.get("product") or {}
                product_id = product.get("id")
                product_name = product.get("name")
                if product_id is None:
                    raise RunError(f"Inventory row missing product.id: {json.dumps(row)[:500]}")
                entry = by_product.setdefault(
                    int(product_id),
                    {
                        "productId": int(product_id),
                        "productName": product_name,
                        "brandName": brand,
                        "categoryName": category,
                        "observedVariantSubcategoryName": (row.get("subcategory") or {}).get("name"),
                        "observedVariantSubcategoryId": (row.get("subcategory") or {}).get("id"),
                        "sites": set(),
                    },
                )
                entry["sites"].add(site["dealerName"])
                site_match_count += 1
            if len(data) < INVENTORY_PAGE_SIZE:
                break
            page += 1
        progress(f"  matched {site_match_count} in-stock {TARGET_BRAND} {TARGET_CATEGORY} rows at {site['dealerName']}")
    for entry in by_product.values():
        entry["sites"] = sorted(entry["sites"])
    return by_product


def resolve_products_to_groups(auth: str, product_ids: set[int]) -> dict[int, int]:
    """Return {productId -> productGroupId} by reading state-catalog rows."""
    if not product_ids:
        return {}
    progress(f"Resolving product->group for {len(product_ids)} variant(s) via state catalog")
    switch_dealer(auth, STATE_DEALER_ID, STATE_DEALER_NAME)
    result: dict[int, int] = {}
    for pid in sorted(product_ids):
        envelope = rpc(auth, "store.product.get", {"id": int(pid)})
        if not isinstance(envelope, dict):
            raise RunError(f"store.product.get({pid}) returned no payload")
        product = envelope.get("product") or {}
        group_id = (
            product.get("productGroupId")
            or (product.get("productGroup") or {}).get("id")
        )
        if group_id is None:
            raise RunError(f"Product {pid} has no productGroupId in state catalog")
        result[int(pid)] = int(group_id)
    return result


def snapshot_group(group: dict[str, Any]) -> dict[str, Any]:
    return {
        "groupId": int(group["id"]),
        "groupName": group.get("name"),
        "brandName": (group.get("brand") or {}).get("name"),
        "categoryId": (group.get("category") or {}).get("id"),
        "categoryName": (group.get("category") or {}).get("name"),
        "subcategoryId": (group.get("subcategory") or {}).get("id") if group.get("subcategory") else None,
        "subcategoryName": (group.get("subcategory") or {}).get("name") if group.get("subcategory") else None,
        "productCount": len(group.get("products") or []),
    }


def verify_cleared(auth: str, group_id: int) -> dict[str, Any]:
    last: dict[str, Any] | None = None
    for attempt in range(1, VERIFY_POLL_ATTEMPTS + 1):
        last = snapshot_group(rpc(auth, "store.product.group.get", {"id": int(group_id)}))
        last["verifyAttempt"] = attempt
        if last.get("subcategoryId") is None:
            return last
        if attempt < VERIFY_POLL_ATTEMPTS:
            time.sleep(VERIFY_POLL_DELAY_SECONDS)
    return last or {}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Actually clear subcategories. Default is dry-run.")
    parser.add_argument(
        "--auth-token-path",
        type=Path,
        default=DEFAULT_AUTH_TOKEN_PATH,
        help=f"Path to Sweed auth token (default {DEFAULT_AUTH_TOKEN_PATH}).",
    )
    args = parser.parse_args()

    if not args.auth_token_path.exists():
        raise RunError(f"Auth token file not found at {args.auth_token_path}")
    auth = args.auth_token_path.read_text().strip()
    if not auth:
        raise RunError(f"Auth token file {args.auth_token_path} is empty")

    in_stock_products = fetch_in_stock_house_of_sacci_vape_products(auth)
    if not in_stock_products:
        raise RunError(
            f"No in-stock {TARGET_BRAND} {TARGET_CATEGORY} rows found across {[s['dealerName'] for s in SITES]}"
        )
    progress(
        f"Discovered {len(in_stock_products)} in-stock {TARGET_BRAND} vape variant(s) across sites; "
        "resolving parent product groups"
    )
    product_to_group = resolve_products_to_groups(auth, set(in_stock_products))

    in_scope: dict[int, dict[str, Any]] = {}
    for product_id, group_id in product_to_group.items():
        product_entry = in_stock_products[product_id]
        bucket = in_scope.setdefault(
            group_id,
            {
                "groupId": group_id,
                "brandName": product_entry["brandName"],
                "categoryName": product_entry["categoryName"],
                "products": [],
                "sites": set(),
            },
        )
        bucket["products"].append(
            {
                "productId": product_id,
                "productName": product_entry["productName"],
                "observedVariantSubcategoryName": product_entry["observedVariantSubcategoryName"],
                "observedVariantSubcategoryId": product_entry["observedVariantSubcategoryId"],
                "sites": product_entry["sites"],
            }
        )
        for site_name in product_entry["sites"]:
            bucket["sites"].add(site_name)
    for bucket in in_scope.values():
        bucket["sites"] = sorted(bucket["sites"])
        bucket["products"].sort(key=lambda item: item["productId"])
    progress(f"Maps to {len(in_scope)} unique product group(s)")

    results: dict[str, Any] = {
        "startedAt": now_iso(),
        "dryRun": not args.apply,
        "stateContext": {"dealerId": STATE_DEALER_ID, "dealerName": STATE_DEALER_NAME},
        "siteContext": SITES,
        "targetBrand": TARGET_BRAND,
        "targetCategory": TARGET_CATEGORY,
        "rationale": (
            "House of Sacci only sells 510 cartridges in this workspace. Per the catalog "
            "creation rule, marking a non-AIO vape as AIO causes spoiled-product refunds; "
            "leaving an AIO unmarked is OK. We therefore clear the subcategory on every "
            "in-stock House of Sacci vape group rather than trusting any inherited label."
        ),
        "groups": [],
    }

    plan: list[dict[str, Any]] = []
    for group_id in sorted(in_scope):
        observed = in_scope[group_id]
        switch_dealer(auth, STATE_DEALER_ID, STATE_DEALER_NAME)
        live = rpc(auth, "store.product.group.get", {"id": int(group_id)})
        before = snapshot_group(live)
        entry = {
            "groupId": int(group_id),
            "groupName": before["groupName"],
            "brandName": before["brandName"],
            "categoryName": before["categoryName"],
            "before": before,
            "observedInventory": observed,
            "status": "pending" if before.get("subcategoryId") is not None else "already-clear",
            "after": None,
            "updatedAt": None,
        }
        plan.append(entry)

    pending = [item for item in plan if item["status"] == "pending"]
    progress(
        f"Plan: {len(pending)} group(s) need their subcategory cleared, "
        f"{len(plan) - len(pending)} already clear"
    )
    for item in plan:
        marker = "->" if item["status"] == "pending" else "  "
        before = item["before"]
        progress(
            f"  {marker} group {item['groupId']:>6} {item['groupName']!r}  "
            f"current subcategory: {before.get('subcategoryName')!r} "
            f"(id={before.get('subcategoryId')})"
        )

    if not args.apply:
        results["groups"] = plan
        results["runStatus"] = "dry_run"
        results["lastUpdatedAt"] = now_iso()
        RESULTS_PATH.write_text(json.dumps(results, indent=2) + "\n")
        progress(f"Dry-run results written to {RESULTS_PATH}. Re-run with --apply to write.")
        return 0

    for index, item in enumerate(pending, start=1):
        group_id = item["groupId"]
        progress(f"Applying {index}/{len(pending)}: group {group_id} {item['groupName']!r}")
        switch_dealer(auth, STATE_DEALER_ID, STATE_DEALER_NAME)
        rpc(auth, "store.product.group.edit", {"id": int(group_id), "subcategoryId": None})
        verified = verify_cleared(auth, group_id)
        item["after"] = verified
        item["updatedAt"] = now_iso()
        if verified.get("subcategoryId") is not None:
            item["status"] = "failed"
            results["groups"] = plan
            results["runStatus"] = "failed"
            results["lastUpdatedAt"] = now_iso()
            RESULTS_PATH.write_text(json.dumps(results, indent=2) + "\n")
            raise RunError(
                f"Group {group_id} ({item['groupName']!r}) still has subcategory "
                f"{verified.get('subcategoryName')!r} after edit"
            )
        item["status"] = "updated"
        results["groups"] = plan
        results["lastUpdatedAt"] = now_iso()
        RESULTS_PATH.write_text(json.dumps(results, indent=2) + "\n")

    updated = sum(1 for item in plan if item["status"] == "updated")
    already = sum(1 for item in plan if item["status"] == "already-clear")
    results["runStatus"] = "completed"
    results["summary"] = {
        "groupCount": len(plan),
        "updatedGroupCount": updated,
        "alreadyClearGroupCount": already,
    }
    results["lastUpdatedAt"] = now_iso()
    RESULTS_PATH.write_text(json.dumps(results, indent=2) + "\n")
    progress(
        f"Done. Cleared subcategory on {updated} group(s); {already} already clear. "
        f"Results: {RESULTS_PATH}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RunError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
