#!/usr/bin/env python3
"""Apply (or dry-run) a plan exported from the 1Off Bronx OTD scratchpad v2.

The plan JSON is produced by the "export apply plan" button on
`page.html` and contains only edits for rows the operator marked
"approved".

This driver only writes *pricing* mutations:

  - `global-price-edit`     -> `store.product.edit {id, price}` at the
                               state dealer (210248).
  - `local-price-create`    -> `store.product.edit {id, price}` at the
    `local-price-update`       Bronx dealer (210249).
  - `local-price-reset`     -> `store.product.price.local.reset
                                {productIds: [...]}` at Bronx.

Any per-row/group/brand promo-override notes are surfaced in the
results file ("promoNotes") but never written; promo amount changes
are handled out-of-band by the operator (see
`docs/helios/pricing-page-promo-aware-scratchpad/README.md`).

Usage:
  python3 apply_plan.py plan.json              # dry run
  python3 apply_plan.py plan.json --apply      # write to Sweed
  python3 apply_plan.py plan.json --apply \\
        --results-out results.json
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
BRONX_DEALER_ID = 210249

KIND_GLOBAL_EDIT = "global-price-edit"
KIND_LOCAL_CREATE = "local-price-create"
KIND_LOCAL_UPDATE = "local-price-update"
KIND_LOCAL_RESET = "local-price-reset"
PRICING_KINDS = {
    KIND_GLOBAL_EDIT,
    KIND_LOCAL_CREATE,
    KIND_LOCAL_UPDATE,
    KIND_LOCAL_RESET,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def switch_dealer(dealer_id: int) -> None:
    sweed.api_call("store.auth.dealer.set", {"dealerId": dealer_id})


def normalize_price(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        return round(float(value) + 1e-9, 2)
    except (TypeError, ValueError):
        return None


def collect(plan: dict) -> tuple[dict[str, list[dict]], list[dict]]:
    """Bucket plan.pricingEdits entries by kind.

    Returns (buckets, skipped_unknown_kind).
    """
    buckets: dict[str, list[dict]] = {k: [] for k in PRICING_KINDS}
    skipped: list[dict] = []
    for entry in plan.get("pricingEdits", []):
        kind = entry.get("kind")
        if kind in PRICING_KINDS:
            buckets[kind].append(entry)
        else:
            skipped.append({"reason": f"unknown-kind:{kind}", "entry": entry})
    return buckets, skipped


def apply_global_edit(entry: dict, *, apply: bool) -> dict:
    product_id = int(entry["productId"])
    price = normalize_price(entry.get("newPrice"))
    if price is None:
        return {"productId": product_id, "kind": KIND_GLOBAL_EDIT, "status": "skip:no-price"}
    record = {
        "productId": product_id,
        "kind": KIND_GLOBAL_EDIT,
        "dealerId": STATE_DEALER_ID,
        "price": price,
        "previousPrice": entry.get("currentPrice"),
        "name": entry.get("name"),
    }
    if not apply:
        record["status"] = "dry-run"
        return record
    sweed.api_call("store.product.edit", {"id": product_id, "price": price})
    record["status"] = "applied"
    record["at"] = now_iso()
    return record


def apply_local_edit(entry: dict, *, apply: bool) -> dict:
    product_id = int(entry["productId"])
    price = normalize_price(entry.get("newPrice"))
    if price is None:
        return {
            "productId": product_id,
            "kind": entry.get("kind"),
            "status": "skip:no-price",
        }
    record = {
        "productId": product_id,
        "kind": entry.get("kind"),
        "dealerId": BRONX_DEALER_ID,
        "price": price,
        "previousLocalPrice": entry.get("currentLocalPrice"),
        "name": entry.get("name"),
    }
    if not apply:
        record["status"] = "dry-run"
        return record
    sweed.api_call("store.product.edit", {"id": product_id, "price": price})
    record["status"] = "applied"
    record["at"] = now_iso()
    return record


def apply_local_reset(entries: list[dict], *, apply: bool) -> list[dict]:
    if not entries:
        return []
    product_ids = sorted({int(e["productId"]) for e in entries})
    name_by_id = {int(e["productId"]): e.get("name") for e in entries}
    record_template = lambda pid: {
        "productId": pid,
        "kind": KIND_LOCAL_RESET,
        "dealerId": BRONX_DEALER_ID,
        "name": name_by_id.get(pid),
    }
    if not apply:
        return [
            {**record_template(pid), "status": "dry-run"} for pid in product_ids
        ]
    sweed.api_call("store.product.price.local.reset", {"productIds": product_ids})
    ts = now_iso()
    return [
        {**record_template(pid), "status": "applied", "at": ts}
        for pid in product_ids
    ]


def run(plan_path: Path, *, apply: bool, results_out: Path | None) -> dict:
    plan = json.loads(plan_path.read_text())
    buckets, skipped = collect(plan)
    promo_notes = plan.get("promoNotes", [])

    summary = {
        "planSource": str(plan_path),
        "planGeneratedAt": plan.get("generatedAt"),
        "campaignId": plan.get("campaignId"),
        "actionId": plan.get("actionId"),
        "pageDiscountPercent": plan.get("pageDiscountPercent"),
        "approvedRowCount": plan.get("approvedRowCount"),
        "mode": "apply" if apply else "dry-run",
        "ranAt": now_iso(),
        "counts": {k: len(v) for k, v in buckets.items()},
        "promoNotesCount": len(promo_notes),
        "skipped": skipped,
    }

    results: list[dict] = []

    if apply:
        # global writes first, then site-level edits
        if buckets[KIND_GLOBAL_EDIT]:
            switch_dealer(STATE_DEALER_ID)
            for entry in buckets[KIND_GLOBAL_EDIT]:
                results.append(apply_global_edit(entry, apply=True))
        if (
            buckets[KIND_LOCAL_CREATE]
            or buckets[KIND_LOCAL_UPDATE]
            or buckets[KIND_LOCAL_RESET]
        ):
            switch_dealer(BRONX_DEALER_ID)
            for entry in buckets[KIND_LOCAL_CREATE]:
                results.append(apply_local_edit(entry, apply=True))
            for entry in buckets[KIND_LOCAL_UPDATE]:
                results.append(apply_local_edit(entry, apply=True))
            results.extend(
                apply_local_reset(buckets[KIND_LOCAL_RESET], apply=True)
            )
    else:
        for entry in buckets[KIND_GLOBAL_EDIT]:
            results.append(apply_global_edit(entry, apply=False))
        for entry in buckets[KIND_LOCAL_CREATE]:
            results.append(apply_local_edit(entry, apply=False))
        for entry in buckets[KIND_LOCAL_UPDATE]:
            results.append(apply_local_edit(entry, apply=False))
        results.extend(
            apply_local_reset(buckets[KIND_LOCAL_RESET], apply=False)
        )

    payload = {
        **summary,
        "results": results,
        "promoNotes": promo_notes,
    }

    if results_out is not None:
        results_out.write_text(json.dumps(payload, indent=2) + "\n")

    # console-friendly summary
    print(f"plan: {plan_path}")
    print(f"mode: {payload['mode']}")
    for kind, count in summary["counts"].items():
        print(f"  {kind:24s} {count:4d}")
    print(f"  promo-notes (not applied)    {len(promo_notes):4d}")
    if skipped:
        print(f"  skipped (unknown-kind)       {len(skipped):4d}")
    if results_out:
        print(f"results -> {results_out}")
    if promo_notes:
        print("\npromo overrides (out-of-band, NOT applied):")
        for ov in promo_notes:
            target = (
                ov.get("name")
                or ov.get("productId")
                or ov.get("brand")
                or ov.get("groupId")
            )
            print(
                f"  - source={ov.get('source')} target={target} "
                f"effective%={ov.get('effectivePromoPercent')}"
            )
    return payload


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path, help="plan JSON from build_page.mjs")
    parser.add_argument("--apply", action="store_true",
                        help="actually write to Sweed (default: dry-run)")
    parser.add_argument("--results-out", type=Path, default=None,
                        help="optional results JSON path")
    args = parser.parse_args(argv)
    if not args.plan.exists():
        parser.error(f"plan file does not exist: {args.plan}")
    run(args.plan, apply=args.apply, results_out=args.results_out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
