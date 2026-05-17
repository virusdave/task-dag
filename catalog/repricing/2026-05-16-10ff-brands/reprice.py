#!/usr/bin/env python3
"""Reprice every catalog variant for the nine brands that appeared on the
2026-05-15 midtown 10FF order to a 67.7% target GM% at the state-level
catalog dealer, rounded to the nearest $0.25 with a mild pull toward
.00 and .50 endings.

Brands in scope (from `catalog/purchases/2026-05-15/manifest_10ff.json`):
  Doobie Labs, Herb, Jungle Girl, Moonlit Hash Co, Preferred Gardens,
  Purps, Runtz, Smartbud, Strain Gang

Per vendor agreement, the 67.7% catalog price is intentionally above the
usual non-MSO 55-65% band; the spread is discounted back to the customer
via active promos. This driver only touches the catalog price; promos are
out of scope.

Formula:
  price = (1.13 * wholesale_cost) / (1 - 0.677)
        = wholesale_cost * 1.13 / 0.323
        ~= 3.4985 * wholesale_cost

Rounding (fractional dollars):
  0.000 <= x <  0.150  ->  0.00
  0.150 <= x <  0.350  ->  0.25
  0.350 <= x <  0.650  ->  0.50
  0.650 <= x <  0.850  ->  0.75
  0.850 <= x <  1.000  ->  next-dollar .00

Cost source: most recent `pricesLists` entry across all distributor-
product links for the variant (i.e. most-recent-purchase-from-Sweed).
Variants with no usable wholesale cost are reported and skipped.

Mutations: `store.product.edit` with `{id, price}` at the state dealer
context (210248 / Freshly Baked NY). Per-site Bronx/Midtown overrides
are not touched.

Usage:
  python3 reprice.py                  # dry run, writes report only
  python3 reprice.py --apply          # write proposed prices to Sweed

Optional flags:
  --brand "Herb"        Only process a single brand (case-insensitive).
  --limit N             Cap the number of products processed (debugging).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_ROOT = WORKDIR.parents[2]
SWEED_HELPER_DIR = AUTOMATION_ROOT / "bulk_additions" / "2026-04-10"
if str(SWEED_HELPER_DIR) not in sys.path:
    sys.path.insert(0, str(SWEED_HELPER_DIR))
import apply_product_catalog_attribute_updates as sweed  # noqa: E402

STATE_DEALER_ID = 210248
STATE_DEALER_NAME = "Freshly Baked NY"
TARGET_GM_PERCENT = 67.7
POST_TAX_MULTIPLIER = 1.13
PRICE_FLOOR = 0.50  # never push a variant below this; flag instead
PRICE_EPSILON = 0.005

TARGET_BRAND_NAMES = [
    "Doobie Labs",
    "Herb",
    "Jungle Girl",
    "Moonlit Hash Co",
    "Preferred Gardens",
    "Purps",
    "Runtz",
    "Smartbud",
    "Strain Gang",
]


# --- pricing math ----------------------------------------------------------

def target_price_from_cost(cost: float) -> float:
    """Raw 67.7% GM target price (pre-rounding)."""
    return (POST_TAX_MULTIPLIER * cost) / (1.0 - TARGET_GM_PERCENT / 100.0)


def round_with_band_bias(price: float) -> float:
    """Round to .00/.25/.50/.75 with mild bias toward .00 and .50.

    Bands are 0.30 wide around .00 and .50, and 0.20 wide around .25 and
    .75 (see docstring). The max push in either direction is 0.15. Works
    on integer mils internally so float quantization (e.g. 45.15 stored
    as 45.149999...) does not flip the decision.
    """
    if price < 0:
        raise ValueError("price must be non-negative")
    mils_total = int(round(price * 1000))
    whole = mils_total // 1000
    frac_mils = mils_total - whole * 1000
    if frac_mils < 150:
        return float(whole)
    if frac_mils < 350:
        return float(whole) + 0.25
    if frac_mils < 650:
        return float(whole) + 0.50
    if frac_mils < 850:
        return float(whole) + 0.75
    return float(whole + 1)


def gm_percent(cost: float, price: float) -> float:
    if price <= 0:
        return float("nan")
    return (1.0 - POST_TAX_MULTIPLIER * cost / price) * 100.0


# --- rounding self-test ----------------------------------------------------

def _self_test() -> None:
    cases = [
        (0.000, 0.00),
        (0.149, 0.00),
        (0.150, 0.25),
        (0.250, 0.25),
        (0.349, 0.25),
        (0.350, 0.50),
        (0.500, 0.50),
        (0.649, 0.50),
        (0.650, 0.75),
        (0.849, 0.75),
        (0.850, 1.00),
        (0.999, 1.00),
        (12.480, 12.50),
        (52.477, 52.50),  # 67.7% GM on $15 cost
        (45.025, 45.00),
        (45.149, 45.00),
        (45.150, 45.25),
        (99.999, 100.00),
    ]
    failed = []
    for value, expected in cases:
        got = round_with_band_bias(value)
        if abs(got - expected) > 1e-9:
            failed.append((value, expected, got))
    if failed:
        raise AssertionError(
            f"round_with_band_bias self-test failed: {failed}"
        )


# --- Sweed helpers ---------------------------------------------------------

def resolve_brand_ids(brand_names: list[str]) -> dict[str, dict]:
    brands = sweed.api_call(
        "store.product.brand.list", {"page": 1, "pageSize": 1000000}
    )
    by_lower = {b["name"].lower(): b for b in brands}
    out: dict[str, dict] = {}
    missing = []
    for name in brand_names:
        row = by_lower.get(name.lower())
        if not row:
            missing.append(name)
            continue
        out[name] = row
    if missing:
        raise RuntimeError(f"Brands not found in Sweed catalog: {missing}")
    return out


def list_groups_for_brand(brand_id: int) -> list[dict]:
    resp = sweed.api_call(
        "store.product.group.list",
        {"page": 1, "pageSize": 1000000, "brandIds": [brand_id]},
    )
    if isinstance(resp, dict):
        return list(resp.get("data") or [])
    return list(resp)


def get_group(group_id: int) -> dict:
    return sweed.api_call("store.product.group.get", {"id": group_id})


def get_product(product_id: int) -> dict:
    payload = sweed.api_call("store.product.get", {"id": str(product_id)})
    if isinstance(payload, dict) and "product" in payload:
        return payload["product"]
    return payload


def list_distributor_products(product_id: int) -> list[dict]:
    resp = sweed.api_call(
        "store.distributor.product.list",
        {"page": 1, "pageSize": 1000, "productId": product_id},
    )
    if isinstance(resp, dict):
        return list(resp.get("data") or [])
    return list(resp)


def parse_iso_date(value) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        text = str(value).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text)
    except Exception:
        return None


def most_recent_cost(distributor_rows: list[dict]) -> tuple[float | None, dict]:
    """Walk every `pricesLists` entry across every distributor row and
    return the price with the latest `fromDate` (ties broken by larger
    price-list id). Returns (cost_or_none, debug_info)."""
    best: tuple[datetime, int, float, dict] | None = None
    debug_entries: list[dict] = []
    for dist_row in distributor_rows:
        dist_id = dist_row.get("id")
        dist_name = dist_row.get("name")
        dist_distributor = (dist_row.get("distributor") or {}).get("name")
        for entry in dist_row.get("pricesLists") or []:
            from_date = parse_iso_date(entry.get("fromDate"))
            price_value = entry.get("price")
            try:
                price_float = float(price_value)
            except (TypeError, ValueError):
                continue
            list_id = int(entry.get("id") or 0)
            debug_entries.append({
                "distributorProductId": dist_id,
                "distributorProductName": dist_name,
                "distributorName": dist_distributor,
                "priceListId": entry.get("id"),
                "fromDate": entry.get("fromDate"),
                "price": price_float,
            })
            if price_float <= 0:
                continue
            # Use epoch=0 as fallback so any dated entry beats undated ones.
            sort_key_date = from_date or datetime(1970, 1, 1, tzinfo=timezone.utc)
            candidate = (sort_key_date, list_id, price_float, {
                "distributorProductId": dist_id,
                "distributorProductName": dist_name,
                "distributorName": dist_distributor,
                "priceListId": entry.get("id"),
                "fromDate": entry.get("fromDate"),
                "price": price_float,
            })
            if best is None or candidate > best:
                best = candidate

    cost = None if best is None else best[2]
    chosen = None if best is None else best[3]
    return cost, {
        "chosen": chosen,
        "allEntries": debug_entries,
    }


# --- core walker -----------------------------------------------------------

def build_proposal(
    brand_names: list[str],
    only_brand: str | None,
    limit: int | None,
) -> dict:
    brand_records = resolve_brand_ids(brand_names)
    if only_brand:
        match_key = only_brand.lower()
        brand_records = {
            k: v for k, v in brand_records.items() if k.lower() == match_key
        }
        if not brand_records:
            raise RuntimeError(
                f"--brand {only_brand!r} did not match any of the in-scope brands"
            )

    proposal: dict = {
        "generatedAt": datetime.now(timezone.utc)
            .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "stateDealerId": STATE_DEALER_ID,
        "stateDealerName": STATE_DEALER_NAME,
        "targetGmPercent": TARGET_GM_PERCENT,
        "postTaxMultiplier": POST_TAX_MULTIPLIER,
        "brandsRequested": brand_names,
        "brandsResolved": {name: rec["id"] for name, rec in brand_records.items()},
        "groups": [],
    }

    processed_products = 0
    for brand_name, brand_record in brand_records.items():
        brand_id = brand_record["id"]
        groups = list_groups_for_brand(brand_id)
        print(
            f"[{brand_name}] brandId={brand_id} groups={len(groups)}",
            flush=True,
        )
        for group_stub in groups:
            if limit is not None and processed_products >= limit:
                break
            group_id = int(group_stub["id"])
            group_full = get_group(group_id)
            group_record = {
                "brandName": brand_name,
                "brandId": brand_id,
                "groupId": group_id,
                "groupName": group_full.get("name"),
                "fullName": group_full.get("fullName"),
                "category": (group_full.get("category") or {}).get("name"),
                "subcategory": (group_full.get("subcategory") or {}).get("name"),
                "enabled": group_full.get("enabled"),
                "products": [],
            }
            for prod_stub in group_full.get("products") or []:
                if limit is not None and processed_products >= limit:
                    break
                processed_products += 1
                product_id = int(prod_stub["id"])
                product = get_product(product_id)
                current_price = product.get("price")
                tab = product.get("tab")
                name = product.get("name")
                enabled = product.get("enabled")

                dist_rows = list_distributor_products(product_id)
                cost, cost_debug = most_recent_cost(dist_rows)

                product_record: dict = {
                    "productId": product_id,
                    "name": name,
                    "shortName": product.get("shortName"),
                    "tab": tab,
                    "enabled": enabled,
                    "currentPrice": current_price,
                    "currentGmPercent": (
                        round(gm_percent(cost, current_price), 2)
                        if (cost is not None and current_price not in (None, 0))
                        else None
                    ),
                    "wholesaleCost": cost,
                    "costSource": cost_debug.get("chosen"),
                    "distributorRowCount": len(dist_rows),
                }

                if cost is None or cost <= 0:
                    product_record["action"] = "skip"
                    product_record["skipReason"] = (
                        "no-usable-wholesale-cost"
                    )
                    product_record["allCostEntries"] = cost_debug["allEntries"]
                    group_record["products"].append(product_record)
                    print(
                        f"  - {product_id} {name!r} tab={tab} "
                        f"current=${current_price} cost=NONE -> skip",
                        flush=True,
                    )
                    continue

                raw_target = target_price_from_cost(cost)
                proposed_price = round_with_band_bias(raw_target)
                if proposed_price < PRICE_FLOOR:
                    product_record["action"] = "skip"
                    product_record["skipReason"] = (
                        f"proposed-below-floor-{PRICE_FLOOR}"
                    )
                    product_record["rawTargetPrice"] = round(raw_target, 4)
                    product_record["proposedPrice"] = proposed_price
                    group_record["products"].append(product_record)
                    print(
                        f"  - {product_id} {name!r} tab={tab} "
                        f"cost=${cost} raw=${raw_target:.4f} -> floor skip",
                        flush=True,
                    )
                    continue

                product_record["rawTargetPrice"] = round(raw_target, 4)
                product_record["proposedPrice"] = proposed_price
                product_record["proposedGmPercent"] = round(
                    gm_percent(cost, proposed_price), 2
                )

                if (
                    current_price is not None
                    and abs(float(current_price) - proposed_price) < PRICE_EPSILON
                ):
                    product_record["action"] = "keep"
                else:
                    product_record["action"] = "edit"

                arrow = "==" if product_record["action"] == "keep" else "->"
                print(
                    f"  - {product_id} {name!r} tab={tab} cost=${cost:g} "
                    f"current=${current_price} {arrow} ${proposed_price:.2f} "
                    f"(GM {product_record['proposedGmPercent']}%)",
                    flush=True,
                )
                group_record["products"].append(product_record)

            proposal["groups"].append(group_record)
            if limit is not None and processed_products >= limit:
                break

    return proposal


def summarize(proposal: dict) -> dict:
    counts = {"edit": 0, "keep": 0, "skip": 0}
    by_brand: dict[str, dict[str, int]] = {}
    edits: list[dict] = []
    for group in proposal["groups"]:
        brand = group["brandName"]
        per_brand = by_brand.setdefault(
            brand, {"edit": 0, "keep": 0, "skip": 0}
        )
        for product in group["products"]:
            action = product["action"]
            counts[action] = counts.get(action, 0) + 1
            per_brand[action] = per_brand.get(action, 0) + 1
            if action == "edit":
                edits.append({
                    "brand": brand,
                    "groupId": group["groupId"],
                    "groupName": group["groupName"],
                    "productId": product["productId"],
                    "name": product["name"],
                    "tab": product["tab"],
                    "currentPrice": product["currentPrice"],
                    "proposedPrice": product["proposedPrice"],
                    "wholesaleCost": product["wholesaleCost"],
                    "currentGmPercent": product.get("currentGmPercent"),
                    "proposedGmPercent": product.get("proposedGmPercent"),
                })
    return {"counts": counts, "byBrand": by_brand, "edits": edits}


def apply_edits(proposal: dict) -> dict:
    results = {
        "appliedAt": datetime.now(timezone.utc)
            .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "edits": [],
    }
    edit_records = [
        (group, product)
        for group in proposal["groups"]
        for product in group["products"]
        if product["action"] == "edit"
    ]
    print(f"\nApplying {len(edit_records)} price edits at state dealer "
          f"{STATE_DEALER_ID}...", flush=True)
    for index, (group, product) in enumerate(edit_records, start=1):
        edit_params = {"id": product["productId"], "price": product["proposedPrice"]}
        before_price = product["currentPrice"]
        try:
            sweed.api_call("store.product.edit", edit_params)
            after_product = get_product(product["productId"])
            after_price = after_product.get("price")
            entry = {
                "brand": group["brandName"],
                "groupId": group["groupId"],
                "productId": product["productId"],
                "name": product["name"],
                "tab": product["tab"],
                "beforePrice": before_price,
                "requestedPrice": product["proposedPrice"],
                "afterPrice": after_price,
                "ok": (
                    after_price is not None
                    and abs(float(after_price) - product["proposedPrice"]) < PRICE_EPSILON
                ),
            }
            print(
                f"  [{index}/{len(edit_records)}] {product['productId']} "
                f"{product['name']!r}: ${before_price} -> ${after_price}",
                flush=True,
            )
        except Exception as exc:
            entry = {
                "brand": group["brandName"],
                "groupId": group["groupId"],
                "productId": product["productId"],
                "name": product["name"],
                "tab": product["tab"],
                "beforePrice": before_price,
                "requestedPrice": product["proposedPrice"],
                "error": str(exc),
                "ok": False,
            }
            print(
                f"  [{index}/{len(edit_records)}] {product['productId']} "
                f"{product['name']!r}: FAILED: {exc}",
                flush=True,
            )
        results["edits"].append(entry)
    return results


def _enqueue_market_refresh_for_proposal(proposal: dict) -> None:
    """Best-effort: shell out to helios/scripts/enqueue-market-refresh.mjs
    with every productId the proposal touches so Lit Alerts evidence is
    fresh by the time the proposal is reviewed.

    Never raises; failures print a warning so the dry-run still completes.
    """
    product_ids: list[int] = []
    seen: set[int] = set()
    for group in proposal.get("groups", []):
        for product in group.get("products", []):
            pid = product.get("productId")
            if isinstance(pid, int) and pid not in seen:
                seen.add(pid)
                product_ids.append(pid)

    if not product_ids:
        return

    script_path = AUTOMATION_ROOT / "helios" / "scripts" / "enqueue-market-refresh.mjs"
    if not script_path.exists():
        print(
            f"\n[warn] enqueue-market-refresh CLI not found at {script_path}; "
            "skipping market-data enqueue.",
            flush=True,
        )
        return

    import subprocess

    label = WORKDIR.name
    cmd = [
        "node",
        str(script_path),
        "--productIds",
        ",".join(str(pid) for pid in product_ids),
        "--reason",
        "proposal-source",
        "--proposalLabel",
        label,
    ]

    print(
        f"\nEnqueueing {len(product_ids)} product(s) for Lit Alerts "
        f"market-data refresh (proposalLabel={label})...",
        flush=True,
    )
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        print(f"[warn] market-data enqueue skipped: {exc}", flush=True)
        return

    if result.returncode != 0:
        print(
            "[warn] market-data enqueue exited non-zero "
            f"(rc={result.returncode}); stderr was:\n{result.stderr.strip()}",
            flush=True,
        )
        return

    stdout = result.stdout.strip()
    if stdout:
        print(f"  -> {stdout}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="Push price edits to Sweed (otherwise dry-run).")
    parser.add_argument("--brand", default=None,
                        help="Restrict to a single brand (debug aid).")
    parser.add_argument("--limit", type=int, default=None,
                        help="Cap total products processed (debug aid).")
    args = parser.parse_args()

    _self_test()

    sweed.switch_to_state_context()

    proposal = build_proposal(TARGET_BRAND_NAMES, args.brand, args.limit)
    summary = summarize(proposal)

    suffix = "apply" if args.apply else "dryrun"
    proposal_path = WORKDIR / f"reprice_proposal_{suffix}.json"
    summary_path = WORKDIR / f"reprice_summary_{suffix}.json"

    proposal_path.write_text(json.dumps(proposal, indent=2, default=str) + "\n")
    summary_path.write_text(json.dumps(summary, indent=2, default=str) + "\n")

    print("\n=== SUMMARY ===")
    print(f"Total products processed: "
          f"{sum(summary['counts'].values())}")
    for action, count in sorted(summary["counts"].items()):
        print(f"  {action:5s}: {count}")
    print("By brand:")
    for brand, per_brand in sorted(summary["byBrand"].items()):
        print(
            f"  {brand:22s}  edit={per_brand['edit']:3d}  "
            f"keep={per_brand['keep']:3d}  skip={per_brand['skip']:3d}"
        )

    print(f"\nProposal:  {proposal_path}")
    print(f"Summary:   {summary_path}")

    # Fire-and-forget: drop every in-scope productId onto the Helios
    # Lit Alerts market-data refresh queue at proposal-source priority
    # so reviewers see fresh evidence by the time they look at the
    # proposal. We do this at dry-run time (NOT just on --apply) because
    # the operator workflow is: dry-run -> review with fresh evidence ->
    # apply. Helper exits non-zero on plumbing failure but we never
    # fail the dry-run on it.
    _enqueue_market_refresh_for_proposal(proposal)

    if not args.apply:
        print("\nDry run complete. Re-run with --apply to push edits.")
        return

    results = apply_edits(proposal)
    results_path = WORKDIR / "reprice_apply_results.json"
    results_path.write_text(json.dumps(results, indent=2, default=str) + "\n")
    print(f"\nApply results: {results_path}")
    failed = [edit for edit in results["edits"] if not edit.get("ok")]
    if failed:
        print(f"\n{len(failed)} edits failed - see {results_path}", flush=True)
        sys.exit(2)


if __name__ == "__main__":
    main()
