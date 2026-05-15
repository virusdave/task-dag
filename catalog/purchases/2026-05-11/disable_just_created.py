#!/usr/bin/env python3
"""Disable every catalog variant + group that the 2026-05-11 combined apply
just created.

Why: the Herb (and co-located) catalog rows the apply created were sourced
from sparse METRC details and the operator has determined the resulting
catalog entries are not correct. We're rolling them back as inactive while
we wait for a scanned manifest with full product names + METRC codes that
will let us redo the mapping properly.

Per operator directive (2026-05-11):
  - Set every `createdProductId` to status `Disabled` (statusId=3).
  - Set every `createdGroupId` to `enabled: false`.
  - Leave any created strains, effects, flavors active.
  - Leave any created brands active (operator did not request brand
    disablement; brands are non-destructive and benign to keep around).
  - Leave the distributor-product link rows alone for now; they point at
    products that are now Disabled, so the linkage is harmless.

Reads from `combined_apply_results.json` and writes results to
`disable_just_created_results.json` so we have a durable record.
"""

from __future__ import annotations

import json
import socket
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
COMBINED_RESULTS = WORKDIR / "combined_apply_results.json"
RESULTS_PATH = WORKDIR / "disable_just_created_results.json"
SWEED_AUTH_PATH = Path("/Users/amp-local/.secret/sweed/auth-token")
STATE_DEALER_ID = 210248
STATE_DEALER_NAME = "Freshly Baked NY"


def _force_ipv4_once() -> None:
    original = socket.getaddrinfo
    def _ipv4_only(*args, **kwargs):
        return [i for i in original(*args, **kwargs) if i[0] == socket.AF_INET]
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


def switch_state_dealer() -> None:
    response = call("store.auth.dealer.set", {"dealerId": STATE_DEALER_ID})
    user = (response.get("result") or response).get("user") or {}
    if int(user.get("currentDealerId") or 0) != STATE_DEALER_ID:
        raise RuntimeError(f"State dealer switch failed: {user}")


def disable_product(product_id: int) -> dict:
    result = call("store.product.edit", {"id": str(product_id), "statusId": 3})
    return result


def disable_group(group_id: int) -> dict:
    result = call("store.product.group.edit", {"id": int(group_id), "enabled": False})
    return result


def main() -> int:
    combined = json.loads(COMBINED_RESULTS.read_text())
    per_site = combined.get("perSiteResults") or {}
    if not per_site:
        raise RuntimeError(f"No perSiteResults in {COMBINED_RESULTS}")

    switch_state_dealer()

    started_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    results: dict = {
        "startedAt": started_at,
        "rows": [],
        "summary": {
            "productsDisabled": 0,
            "groupsDisabled": 0,
            "productsSkipped": 0,
            "groupsSkipped": 0,
            "errors": [],
        },
    }

    seen_groups: set[int] = set()
    seen_products: set[int] = set()

    for site_key, site_results in per_site.items():
        for row in site_results.get("rows") or []:
            product_id = row.get("createdProductId")
            group_id = row.get("createdGroupId")
            row_record = {
                "siteKey": site_key,
                "distributorProductId": row.get("distributorProductId"),
                "distributorProductName": row.get("distributorProductName"),
                "targetVariantName": row.get("targetVariantName"),
                "createdProductId": product_id,
                "createdGroupId": group_id,
                "productDisable": None,
                "groupDisable": None,
            }

            if product_id and int(product_id) not in seen_products:
                try:
                    disable_product(int(product_id))
                    seen_products.add(int(product_id))
                    results["summary"]["productsDisabled"] += 1
                    row_record["productDisable"] = "ok"
                    print(f"  [ok] product {product_id} ({row.get('targetVariantName')!r}) -> Disabled", flush=True)
                except Exception as exc:  # noqa: BLE001
                    msg = f"product {product_id}: {exc}"
                    results["summary"]["errors"].append(msg)
                    row_record["productDisable"] = f"error: {exc}"
                    print(f"  [FAIL] {msg}", flush=True)
            else:
                row_record["productDisable"] = "skipped (no createdProductId or duplicate)"
                results["summary"]["productsSkipped"] += 1

            if group_id and int(group_id) not in seen_groups:
                try:
                    disable_group(int(group_id))
                    seen_groups.add(int(group_id))
                    results["summary"]["groupsDisabled"] += 1
                    row_record["groupDisable"] = "ok"
                    print(f"  [ok] group   {group_id} ({row.get('targetGroupName') or row.get('targetVariantName')!r}) -> enabled=false", flush=True)
                except Exception as exc:  # noqa: BLE001
                    msg = f"group {group_id}: {exc}"
                    results["summary"]["errors"].append(msg)
                    row_record["groupDisable"] = f"error: {exc}"
                    print(f"  [FAIL] {msg}", flush=True)
            else:
                row_record["groupDisable"] = "skipped (no createdGroupId or duplicate)"
                results["summary"]["groupsSkipped"] += 1

            results["rows"].append(row_record)
            time.sleep(0.05)

    results["finishedAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    RESULTS_PATH.write_text(json.dumps(results, indent=2) + "\n")
    print(
        f"\nSummary: products disabled={results['summary']['productsDisabled']}  "
        f"groups disabled={results['summary']['groupsDisabled']}  "
        f"errors={len(results['summary']['errors'])}\n"
        f"Wrote {RESULTS_PATH}",
        flush=True,
    )
    return 0 if not results["summary"]["errors"] else 2


if __name__ == "__main__":
    sys.exit(main())
