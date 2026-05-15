#!/usr/bin/env python3
"""Pre-warm the LLM parser cache for every distributor product name on
today's pending purchase queues across both sites. Validates each parse
loud-fails on any failure - no silent swallowing.

Run before generating the packet so we surface naming issues up front
instead of half-way through a long generation pass."""

from __future__ import annotations

import json
import socket
import sys
import urllib.request
import uuid
from collections import defaultdict
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
sys.path.insert(0, str(WORKDIR))
import llm_parser  # noqa: E402

SWEED_AUTH_PATH = Path("/Users/amp-local/.secret/sweed/auth-token")
PLACEHOLDER_PRODUCT_NAMES = {"preroll samples samples"}

SITES = [
    {"key": "midtown", "label": "Midtown", "dealerId": 210705},
    {"key": "bronx", "label": "Bronx", "dealerId": 210249},
]


def _force_ipv4_once() -> None:
    original = socket.getaddrinfo

    def _ipv4_only(*args, **kwargs):
        return [info for info in original(*args, **kwargs) if info[0] == socket.AF_INET]

    socket.getaddrinfo = _ipv4_only


_force_ipv4_once()
TOKEN = SWEED_AUTH_PATH.read_text().strip()


def call(name: str, params: dict | None = None) -> dict:
    body = json.dumps(
        {"auth": TOKEN, "name": name, "params": params or {}, "id": str(uuid.uuid4())}
    ).encode()
    request = urllib.request.Request(
        "https://prime.sweedpos.com/api/",
        data=body,
        headers={"content-type": "application/json", "user-agent": "Mozilla/5.0"},
    )
    return json.loads(urllib.request.urlopen(request, timeout=60).read())


def collect_unmapped_per_site(dealer_id: int, label: str) -> list[dict]:
    call("store.auth.dealer.set", {"dealerId": dealer_id})
    queue = call(
        "store.purchase.order.list",
        {
            "orderStatusId": 2,
            "fromDate": "2026-04-01",
            "toDate": "2026-10-11",
            "page": 1,
            "pageSize": 50,
        },
    )
    rows: list[dict] = []
    for it in (queue.get("result", {}) or {}).get("data") or []:
        oid = int(it["id"])
        order = (call("store.purchase.order.get", {"id": oid}).get("result") or {})
        suggestion = call("store.distributor.product.suggestion", {"orderId": oid}).get(
            "result", {}
        ) or {}
        unresolved_ids = {
            str(item["orderPositionId"])
            for item in (suggestion.get("orderPositions") or [])
            if item.get("orderPositionId") is not None
        }
        for position in order.get("positions") or []:
            mapped_name = (
                ((position.get("distributorProduct") or {}).get("product") or {}).get("name", "")
                or ""
            ).strip().lower()
            placeholder = (not position.get("suggestedProduct")) and (
                mapped_name in PLACEHOLDER_PRODUCT_NAMES
            )
            if str(position["id"]) not in unresolved_ids and not placeholder:
                continue
            distributor_product = position.get("distributorProduct") or {}
            rows.append(
                {
                    "site": label,
                    "orderId": oid,
                    "distributor": (order.get("distributor") or {}).get("name", ""),
                    "externalOrderId": order.get("externalOrderId", ""),
                    "distributorProductId": distributor_product.get("id"),
                    "distributorProductName": distributor_product.get("name", ""),
                    "positionId": position.get("id"),
                    "placeholder": placeholder,
                }
            )
    return rows


def main() -> int:
    all_rows: list[dict] = []
    for site in SITES:
        all_rows.extend(collect_unmapped_per_site(site["dealerId"], site["label"]))

    by_distributor = defaultdict(list)
    for row in all_rows:
        by_distributor[row["distributor"]].append(row["distributorProductName"])

    print(f"Total unmapped rows in scope: {len(all_rows)}")
    failures: list[tuple[str, str]] = []
    for row in all_rows:
        siblings = by_distributor[row["distributor"]]
        try:
            parsed = llm_parser.parse_distributor_product_name(
                row["distributorProductName"],
                distributor_company=row["distributor"],
                sibling_names=siblings,
            )
        except Exception as exc:  # noqa: BLE001
            failures.append((row["distributorProductName"], str(exc)))
            print(f"  [FAIL] {row['distributorProductName']!r}: {exc}")
            continue
        print(
            f"  [ok] {row['site']:8} {row['distributorProductName']!r:60} -> "
            f"brand={parsed['brand']!r:30} cat={parsed['category']!r:12} "
            f"variant={parsed['variantName']!r}"
        )

    if failures:
        print(f"\n{len(failures)} parse failure(s); aborting.")
        return 1
    print(f"\nAll {len(all_rows)} rows parsed cleanly. Cache: {llm_parser.CACHE_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
