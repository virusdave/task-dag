#!/usr/bin/env python3
"""Assign the `Cartridge` subcategory to every product group in the
`Vapes` category that currently has a null subcategory.

Operator decision (2026-05-17): the `Vapes` category must have a
subcategory on every group. Rather than continue the
classify-by-evidence work tracked in
`categories/2026-04-13/null_subcategory_lane_classification_packet.*`,
treat `Cartridge` as the safe default for any vape group that still
has no subcategory at all. Operators can re-classify individual groups
later if needed; this is purely a "no group is left subcategory-less"
sweep.

Targets:
  * category.id == 1087 (Vapes)
  * subcategory is null
  * groups in BOTH enabled and disabled states are included, mirroring
    the policy used by
    catalog/2026-05-15-moonys-merge/strip_disabled_subcategories_full_catalog.py
    (we don't want a future re-enable to silently restore the
    "no subcategory" state).

Action: `store.product.group.edit` with `{id, subcategoryId: 1111}`.

Usage:
  python set_null_vapes_subcategory_to_cartridge.py            # dry run
  python set_null_vapes_subcategory_to_cartridge.py --apply    # live writes
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_ROOT = WORKDIR.parents[1]
SWEED_HELPER_DIR = AUTOMATION_ROOT / "bulk_additions" / "2026-04-10"
if str(SWEED_HELPER_DIR) not in sys.path:
    sys.path.insert(0, str(SWEED_HELPER_DIR))

import apply_product_catalog_attribute_updates as sweed  # noqa: E402

STATE_DEALER_ID = 210248
VAPES_CATEGORY_ID = 1087
CARTRIDGE_SUBCATEGORY_ID = 1111


def fetch_all_groups() -> list[dict]:
    out: list[dict] = []
    page = 1
    while True:
        res = sweed.api_call(
            "store.product.group.list", {"page": page, "pageSize": 500}
        )
        data = res.get("data", []) if isinstance(res, dict) else []
        if not data:
            break
        out.extend(data)
        total = res.get("totalCount", 0) if isinstance(res, dict) else 0
        if total and len(out) >= total:
            break
        page += 1
    return out


def now_iso() -> str:
    return (
        dt.datetime.now(dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually issue store.product.group.edit calls.",
    )
    args = parser.parse_args()
    dry_run = not args.apply
    print(f"Mode: {'APPLY' if not dry_run else 'DRY RUN'}")

    sweed.api_call("store.auth.dealer.set", {"dealerId": STATE_DEALER_ID})

    # Sanity-check the subcategory id resolution against the live
    # category list so we never silently target a renamed/disabled id.
    cats = sweed.api_call(
        "store.product.category.list", {"page": 1, "pageSize": 1000}
    )
    if isinstance(cats, dict):
        cats = cats.get("data", cats)
    vapes_cat = next(
        (c for c in cats if c.get("id") == VAPES_CATEGORY_ID), None
    )
    if vapes_cat is None:
        print(
            f"FATAL: Vapes category id {VAPES_CATEGORY_ID} not found in live catalog.",
            file=sys.stderr,
        )
        return 1
    cartridge_sub = next(
        (
            s
            for s in vapes_cat.get("subcategories", [])
            if s.get("id") == CARTRIDGE_SUBCATEGORY_ID
        ),
        None,
    )
    if cartridge_sub is None:
        print(
            f"FATAL: Cartridge subcategory id {CARTRIDGE_SUBCATEGORY_ID} not found on Vapes.",
            file=sys.stderr,
        )
        return 1
    if not cartridge_sub.get("enabled", False):
        print(
            f"FATAL: Cartridge subcategory id {CARTRIDGE_SUBCATEGORY_ID} is disabled live; aborting.",
            file=sys.stderr,
        )
        return 1
    print(
        f"Confirmed live ids: category={VAPES_CATEGORY_ID} `{vapes_cat['name']}`, "
        f"subcategory={CARTRIDGE_SUBCATEGORY_ID} `{cartridge_sub['name']}`."
    )

    groups = fetch_all_groups()
    print(f"Fetched {len(groups)} total groups from live catalog.")

    targets: list[dict] = []
    for g in groups:
        cat = g.get("category") or {}
        sub = g.get("subcategory")
        if cat.get("id") != VAPES_CATEGORY_ID:
            continue
        if sub is not None and sub.get("id") is not None:
            continue
        targets.append(g)

    enabled_count = sum(1 for g in targets if g.get("enabled"))
    disabled_count = len(targets) - enabled_count
    print(
        f"Vapes groups with null subcategory: {len(targets)} "
        f"(enabled={enabled_count}, disabled={disabled_count})."
    )

    actions: list[dict] = []
    failures: list[dict] = []
    for g in targets:
        record = {
            "groupId": g["id"],
            "fullName": g.get("fullName"),
            "groupEnabled": g.get("enabled"),
            "before": {
                "category": g.get("category"),
                "subcategory": g.get("subcategory"),
            },
            "edit": {
                "id": g["id"],
                "subcategoryId": CARTRIDGE_SUBCATEGORY_ID,
            },
        }
        if dry_run:
            actions.append(record)
            print(
                f"  [DRYRUN] group {g['id']} enabled={g.get('enabled')} "
                f"{g.get('fullName')!r}"
            )
            continue
        try:
            sweed.api_call("store.product.group.edit", record["edit"])
            actions.append(record)
            print(
                f"  [OK] group {g['id']} enabled={g.get('enabled')} "
                f"{g.get('fullName')!r}"
            )
        except Exception as exc:  # noqa: BLE001
            failure = {**record, "error": str(exc)}
            failures.append(failure)
            print(
                f"  [FAIL] group {g['id']} {g.get('fullName')!r}: {exc}",
                file=sys.stderr,
            )

    out_path = WORKDIR / (
        "results_apply.json" if not dry_run else "results_dryrun.json"
    )
    out_path.write_text(
        json.dumps(
            {
                "timestamp": now_iso(),
                "mode": "apply" if not dry_run else "dryrun",
                "stateDealerId": STATE_DEALER_ID,
                "vapesCategoryId": VAPES_CATEGORY_ID,
                "cartridgeSubcategoryId": CARTRIDGE_SUBCATEGORY_ID,
                "totalGroupsScanned": len(groups),
                "vapesGroupsWithNullSubcategory": len(targets),
                "actionsTaken": actions,
                "failures": failures,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"\nWrote {out_path}")
    print(
        f"Summary: {len(actions)} {'planned' if dry_run else 'applied'}, "
        f"{len(failures)} failed."
    )
    return 0 if not failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
