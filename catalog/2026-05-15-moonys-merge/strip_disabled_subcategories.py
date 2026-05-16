#!/usr/bin/env python3
"""Scan every catalog product group touched by the 2026-05-13 pending
purchase apply batch and clear any subcategory that is currently
disabled (e.g. `Pre-Packaged Flower`, `Multi-Pack`, `Live Resin
Cartridge`, etc.).

Also reports any disabled strain / flavor / effect / quality-line
references on those groups, per the mandatory standing rule:

    "Never add a disabled subcategory, category, or attribute like
     strain, flavor, effect, etc."

Usage:
  python strip_disabled_subcategories.py            # dry run
  python strip_disabled_subcategories.py --apply    # live
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_ROOT = WORKDIR.parents[1]
SWEED_HELPER_DIR = AUTOMATION_ROOT / "bulk_additions" / "2026-04-10"
COMBINED_APPLY_PATH = (
    AUTOMATION_ROOT / "catalog" / "purchases" / "2026-05-13"
    / "combined_apply_results.json"
)

if str(SWEED_HELPER_DIR) not in sys.path:
    sys.path.insert(0, str(SWEED_HELPER_DIR))

import apply_product_catalog_attribute_updates as sweed  # noqa: E402

STATE_DEALER_ID = 210248


def collect_touched_group_ids(blob) -> list[int]:
    """Walk the apply results JSON and return every product-group id
    that the apply touched (exact-variant + existing-group + new-group).
    """
    seen: set[int] = set()

    def walk(obj):
        if isinstance(obj, dict):
            if "groupSource" in obj:
                gid = (obj.get("groupAfter") or {}).get("id") or obj.get("createdGroupId")
                if gid:
                    seen.add(int(gid))
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for v in obj:
                walk(v)

    walk(blob)
    return sorted(seen)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Live mode")
    args = parser.parse_args()
    dry_run = not args.apply
    print(f"Mode: {'APPLY' if not dry_run else 'DRY RUN'}")

    sweed.api_call("store.auth.dealer.set", {"dealerId": STATE_DEALER_ID})

    apply_blob = json.loads(COMBINED_APPLY_PATH.read_text())
    group_ids = collect_touched_group_ids(apply_blob)
    print(f"Touched groups in batch: {len(group_ids)}")

    # Build maps of disabled attributes.
    cats = sweed.api_call("store.product.category.list", {"page": 1, "pageSize": 1000})
    if isinstance(cats, dict):
        cats = cats.get("data", cats)
    disabled_subcat_ids = set()
    subcat_name_by_id = {}
    for c in cats:
        for s in c.get("subcategories", []):
            subcat_name_by_id[s["id"]] = (c["name"], s["name"])
            if not s.get("enabled", True):
                disabled_subcat_ids.add(s["id"])
    print(f"Disabled subcategories in catalog: {len(disabled_subcat_ids)}")

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

    quality_lines = sweed.api_call("store.product.quality.line.list", {})
    disabled_quality_ids = {q["id"] for q in quality_lines if not q.get("enabled", True)}

    actions: list[dict] = []
    for gid in group_ids:
        g = sweed.api_call("store.product.group.get", {"id": gid})
        sub = g.get("subcategory")
        sub_id = sub["id"] if sub else None

        edits: dict = {"id": gid}
        notes: list[str] = []

        if sub_id and sub_id in disabled_subcat_ids:
            edits["subcategoryId"] = None
            cat_name, sub_name = subcat_name_by_id.get(sub_id, ("?", "?"))
            notes.append(
                f"clear subcategory {sub_id} `{cat_name} / {sub_name}` (disabled)"
            )

        # Strain
        strain = g.get("strain")
        if strain and strain["id"] in disabled_strain_ids:
            notes.append(
                f"WARNING strain {strain['id']} `{strain['name']}` disabled"
            )

        # Effects
        bad_effects = [
            e for e in g.get("effects") or [] if e.get("id") in disabled_effect_ids
        ]
        if bad_effects:
            notes.append(
                f"WARNING effects disabled: "
                f"{[e.get('name') for e in bad_effects]}"
            )

        # Flavors / flavorings
        flavor_field = (
            g.get("flavorings") if g.get("flavorings") is not None else g.get("flavors")
        ) or []
        bad_flavors = [
            f for f in flavor_field if f.get("id") in disabled_flavor_ids
        ]
        if bad_flavors:
            notes.append(
                f"WARNING flavors disabled: {[f.get('name') for f in bad_flavors]}"
            )

        # Quality line
        ql = g.get("qualityLine")
        if ql and ql.get("id") in disabled_quality_ids:
            notes.append(
                f"WARNING quality line {ql['id']} `{ql.get('name')}` disabled"
            )

        if not notes:
            continue

        action = {
            "groupId": gid,
            "fullName": g.get("fullName"),
            "before": {
                "subcategory": sub,
                "strain": strain,
                "effects": [e.get("name") for e in (g.get("effects") or [])],
                "flavors": [f.get("name") for f in flavor_field],
                "qualityLine": ql,
            },
            "notes": notes,
            "edits": {k: v for k, v in edits.items() if k != "id"},
        }

        if "subcategoryId" in edits and not dry_run:
            sweed.api_call("store.product.group.edit", edits)
            after = sweed.api_call("store.product.group.get", {"id": gid})
            action["afterSubcategory"] = after.get("subcategory")
        actions.append(action)
        print(f"  [{gid}] {g.get('fullName')!r}: {'; '.join(notes)}")

    out_path = WORKDIR / (
        "strip_disabled_results_apply.json" if not dry_run else "strip_disabled_results_dryrun.json"
    )
    out_path.write_text(
        json.dumps(
            {
                "mode": "apply" if not dry_run else "dryrun",
                "totalGroupsScanned": len(group_ids),
                "actionsTaken": actions,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"\nGroups with issues: {len(actions)}")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
