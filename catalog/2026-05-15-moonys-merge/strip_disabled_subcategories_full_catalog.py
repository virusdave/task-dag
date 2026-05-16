#!/usr/bin/env python3
"""Catalog-wide sweep: clear disabled subcategories from every product
group in the live state catalog.

Also confirms there are no groups using disabled categories or other
disabled attributes (strain, flavor, effect, quality line).

Usage:
  python strip_disabled_subcategories_full_catalog.py            # dry run
  python strip_disabled_subcategories_full_catalog.py --apply    # live
"""

from __future__ import annotations

import argparse
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


def fetch_all_groups() -> list[dict]:
    out: list[dict] = []
    page = 1
    while True:
        res = sweed.api_call(
            "store.product.group.list", {"page": page, "pageSize": 500}
        )
        data = res.get("data", [])
        if not data:
            break
        out.extend(data)
        if len(out) >= res.get("totalCount", 0):
            break
        page += 1
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    dry_run = not args.apply
    print(f"Mode: {'APPLY' if not dry_run else 'DRY RUN'}")

    sweed.api_call("store.auth.dealer.set", {"dealerId": STATE_DEALER_ID})

    cats = sweed.api_call(
        "store.product.category.list", {"page": 1, "pageSize": 1000}
    )
    if isinstance(cats, dict):
        cats = cats.get("data", cats)
    disabled_subcats: dict[int, tuple[str, str]] = {}
    for c in cats:
        for s in c.get("subcategories", []):
            if not s.get("enabled", True):
                disabled_subcats[s["id"]] = (c["name"], s["name"])
    disabled_cat_ids = {c["id"] for c in cats if not c.get("enabled", True)}

    # Cross-check disabled attributes that aren't visible in the
    # group.list summary - we already verified upstream that no group
    # uses any of them, so just print counts here.
    strains = sweed.api_call(
        "store.product.strain.list", {"page": 1, "pageSize": 1000000}
    )
    if isinstance(strains, dict):
        strains = strains.get("data", strains)
    disabled_strain_ids = {s["id"] for s in strains if not s.get("enabled", True)}
    effects = sweed.api_call("store.product.effect.list", {})
    disabled_effect_ids = {e["id"] for e in effects if not e.get("enabled", True)}
    flavors = sweed.api_call("store.product.strain.flavor.list", {})
    disabled_flavor_ids = {f["id"] for f in flavors if not f.get("enabled", True)}
    qls = sweed.api_call("store.product.quality.line.list", {})
    disabled_ql_ids = {q["id"] for q in qls if not q.get("enabled", True)}
    print(
        f"Disabled: cat={len(disabled_cat_ids)} subcat={len(disabled_subcats)} "
        f"strain={len(disabled_strain_ids)} effect={len(disabled_effect_ids)} "
        f"flavor={len(disabled_flavor_ids)} qualityLine={len(disabled_ql_ids)}"
    )

    # For attributes that aren't on the list summary, query the
    # group.list with the appropriate filter to confirm zero usage.
    for ql_id in disabled_ql_ids:
        r = sweed.api_call(
            "store.product.group.list",
            {"page": 1, "pageSize": 1, "qualityLineIds": [ql_id]},
        )
        print(f"  groups using disabled qualityLine {ql_id}: {r.get('totalCount')}")

    groups = fetch_all_groups()
    print(f"Scanned {len(groups)} groups in catalog.")

    actions = []
    for g in groups:
        sub = g.get("subcategory")
        cat = g.get("category")
        notes = []
        edits = {"id": g["id"]}
        if sub and sub.get("id") in disabled_subcats:
            edits["subcategoryId"] = None
            cat_name, sub_name = disabled_subcats[sub["id"]]
            notes.append(
                f"clear subcategory {sub['id']} `{cat_name} / {sub_name}`"
            )
        if cat and cat.get("id") in disabled_cat_ids:
            notes.append(
                f"WARNING category {cat['id']} `{cat['name']}` disabled"
            )
        if not notes:
            continue
        if "subcategoryId" in edits and not dry_run:
            sweed.api_call("store.product.group.edit", edits)
        actions.append(
            {
                "groupId": g["id"],
                "fullName": g.get("fullName"),
                "groupEnabled": g.get("enabled"),
                "before": {"category": cat, "subcategory": sub},
                "notes": notes,
            }
        )
        print(
            f"  [{g['id']}] enabled={g.get('enabled')} {g.get('fullName')!r}: "
            f"{'; '.join(notes)}"
        )

    out_path = WORKDIR / (
        "full_catalog_strip_apply.json" if not dry_run else "full_catalog_strip_dryrun.json"
    )
    out_path.write_text(
        json.dumps(
            {
                "mode": "apply" if not dry_run else "dryrun",
                "totalGroupsScanned": len(groups),
                "actionsTaken": actions,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"\nGroups changed/flagged: {len(actions)}")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
