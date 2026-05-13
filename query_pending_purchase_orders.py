#!/usr/bin/env python3
"""
Query Sweed to find all pending purchase orders across both sites.
Per AGENTS_MUST_KNOW.md, uses:
- store.auth.dealer.set for each site
- store.purchase.order.list with orderStatusId: 2 (outstanding delivered orders)
- Last 60 days delivery date window
"""
import json
import sys
import urllib.request
import urllib.parse
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

API_URL = "https://prime.sweedpos.com/api/"

MIDTOWN_DEALER_ID = 210705
BRONX_DEALER_ID = 210249

GENERIC_PLACEHOLDERS = {
    "preroll samples samples",
    "edibles samples 10x 10mg",
}


def call_sweed_rpc(auth_token: str, name: str, params: dict[str, Any] | None = None) -> Any:
    """Make a Sweed JSON-RPC API call using curl with forced IPv4."""
    import subprocess

    payload = {
        "auth": auth_token,
        "id": str(uuid4()),
        "name": name,
    }
    if params:
        payload["params"] = params

    payload_json = json.dumps(payload)

    result = subprocess.run(
        [
            "curl",
            "-4",
            "-s",
            API_URL,
            "-H",
            "Content-Type: application/json",
            "-d",
            payload_json,
        ],
        capture_output=True,
        text=True,
        check=True,
    )

    envelope = json.loads(result.stdout)
    if envelope.get("error"):
        raise RuntimeError(f"{name} failed: {envelope['error']}")
    if "result" not in envelope:
        raise RuntimeError(f"{name} returned no result")

    return envelope["result"]


def set_dealer_context(auth_token: str, dealer_id: int) -> dict[str, Any]:
    """Set the dealer context and verify."""
    result = call_sweed_rpc(auth_token, "store.auth.dealer.set", {"dealerId": dealer_id})
    current_dealer_id = result["user"]["currentDealerId"]
    current_dealer_name = result["user"].get("currentDealerName", "")

    if current_dealer_id != dealer_id:
        raise RuntimeError(
            f"Dealer context mismatch. Expected {dealer_id}, got {current_dealer_id} {current_dealer_name}"
        )

    print(f"✓ Set dealer context: {current_dealer_id} - {current_dealer_name}", file=sys.stderr)
    return result


def list_outstanding_purchase_orders(
    auth_token: str, dealer_id: int, from_date: str, to_date: str
) -> list[dict[str, Any]]:
    """List outstanding purchase orders for a dealer."""
    orders = []
    page = 1
    page_size = 50

    while True:
        response = call_sweed_rpc(
            auth_token,
            "store.purchase.order.list",
            {
                "orderStatusId": 2,
                "fromDate": from_date,
                "toDate": to_date,
                "page": page,
                "pageSize": page_size,
            },
        )

        batch = response.get("data", [])
        orders.extend(batch)

        total_count = response.get("totalCount", 0)
        if len(orders) >= total_count or len(batch) < page_size:
            break

        page += 1

    return orders


def get_purchase_order_details(auth_token: str, order_id: int) -> dict[str, Any]:
    """Get full purchase order details."""
    return call_sweed_rpc(auth_token, "store.purchase.order.get", {"id": order_id})


def is_generic_placeholder(product_name: str | None) -> bool:
    """Check if a product name is a generic placeholder."""
    if not product_name:
        return False
    return product_name.lower().strip() in GENERIC_PLACEHOLDERS


def analyze_position(position: dict[str, Any]) -> dict[str, Any]:
    """Analyze a purchase order position for mapping status."""
    position_id = position.get("id")
    distributor_product = position.get("distributorProduct", {}) or {}
    suggested_product = position.get("suggestedProduct")

    distributor_product_id = distributor_product.get("id")
    distributor_product_name = distributor_product.get("name", "")

    catalog_product = distributor_product.get("product")
    catalog_product_id = catalog_product.get("id") if catalog_product else None
    catalog_product_name = catalog_product.get("name", "") if catalog_product else ""

    has_distributor_product = bool(distributor_product_id)
    has_catalog_product = bool(catalog_product_id)
    is_placeholder = is_generic_placeholder(catalog_product_name)

    issue = None
    if not has_distributor_product:
        issue = "NO_DISTRIBUTOR_PRODUCT"
    elif not has_catalog_product:
        issue = "UNMAPPED"
    elif is_placeholder:
        issue = "GENERIC_PLACEHOLDER"

    return {
        "positionId": position_id,
        "distributorProductId": distributor_product_id,
        "distributorProductName": distributor_product_name,
        "catalogProductId": catalog_product_id,
        "catalogProductName": catalog_product_name,
        "suggestedProductId": suggested_product.get("id") if suggested_product else None,
        "issue": issue,
    }


def main() -> None:
    """Main entry point."""
    auth_token_path = Path.home() / ".secret" / "sweed" / "auth-token"
    if not auth_token_path.exists():
        print(f"Error: Auth token not found at {auth_token_path}", file=sys.stderr)
        sys.exit(1)

    auth_token = auth_token_path.read_text().strip()

    to_date = datetime.now().strftime("%Y-%m-%d")
    from_date = (datetime.now() - timedelta(days=60)).strftime("%Y-%m-%d")

    print(f"Query window: {from_date} to {to_date}", file=sys.stderr)
    print(file=sys.stderr)

    sites = [
        {"name": "Midtown", "dealerId": MIDTOWN_DEALER_ID},
        {"name": "Bronx", "dealerId": BRONX_DEALER_ID},
    ]

    all_results = []

    for site in sites:
        site_name = site["name"]
        dealer_id = site["dealerId"]

        print(f"=== {site_name} (Dealer {dealer_id}) ===", file=sys.stderr)

        set_dealer_context(auth_token, dealer_id)

        orders = list_outstanding_purchase_orders(auth_token, dealer_id, from_date, to_date)
        print(f"Found {len(orders)} pending orders", file=sys.stderr)

        for order_summary in orders:
            order_id = order_summary["id"]
            print(f"  Analyzing order {order_id}...", file=sys.stderr)

            order_detail = get_purchase_order_details(auth_token, order_id)

            positions = order_detail.get("positions", [])
            for position in positions:
                analysis = analyze_position(position)
                if analysis["issue"]:
                    all_results.append(
                        {
                            "site": site_name,
                            "dealerId": dealer_id,
                            "orderId": order_id,
                            **analysis,
                        }
                    )

        print(file=sys.stderr)

    # Summary
    total_issues = len(all_results)
    unmapped = sum(1 for r in all_results if r["issue"] == "UNMAPPED")
    generic = sum(1 for r in all_results if r["issue"] == "GENERIC_PLACEHOLDER")
    no_dist = sum(1 for r in all_results if r["issue"] == "NO_DISTRIBUTOR_PRODUCT")

    print("=== SUMMARY ===", file=sys.stderr)
    print(f"Total issues found: {total_issues}", file=sys.stderr)
    print(f"  Unmapped positions: {unmapped}", file=sys.stderr)
    print(f"  Generic placeholder mappings: {generic}", file=sys.stderr)
    print(f"  No distributor product: {no_dist}", file=sys.stderr)
    print(file=sys.stderr)

    # Output full results as JSON
    print(json.dumps(all_results, indent=2))


if __name__ == "__main__":
    main()
