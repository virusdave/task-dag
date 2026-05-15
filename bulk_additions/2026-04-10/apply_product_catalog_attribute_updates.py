#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import hashlib
import json
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter, defaultdict
from pathlib import Path

import generate_product_catalog_attribute_analysis as analysis


WORKDIR = Path(__file__).resolve().parent
REPORT_PATH = WORKDIR / "product_catalog_attribute_analysis.json"
PLAN_PATH = WORKDIR / "product_catalog_attribute_write_plan.json"
RESULTS_PATH = WORKDIR / "product_catalog_attribute_write_results.json"

STATE_DEALER_ID = 210248
STATE_DEALER_NAME = "Freshly Baked NY"
ACTIONABLE_STATUSES = {"reviewed-group", "verified-proxy", "verified-equivalent"}
POSITIVE_EFFECT_CATEGORY_NAME = "Positive"


class SkipGroup(Exception):
    pass


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def request_id() -> str:
    return str(uuid.uuid4())


def api_call(name: str, params: dict | None = None):
    payload = json.dumps(
        {
            "auth": analysis.AUTH_TOKEN,
            "name": name,
            "params": params or {},
            "id": request_id(),
        }
    ).encode()
    request = urllib.request.Request(
        analysis.API_URL,
        data=payload,
        headers={
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0",
        },
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = json.load(response)
            if "error" in body:
                raise RuntimeError(f"{name} failed: {json.dumps(body['error'], sort_keys=True)}")
            if "result" not in body:
                raise RuntimeError(f"{name} returned unexpected payload: {json.dumps(body, sort_keys=True)[:2000]}")
            return body["result"]
        except urllib.error.HTTPError as exc:
            if exc.code not in {403, 429, 500, 502, 503, 504} or attempt == 2:
                raise
            time.sleep(1 + attempt)


def read_json(path: Path):
    return json.loads(path.read_text())


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")


def dedupe_preserve_order(values: list[str]) -> list[str]:
    output = []
    seen = set()
    for value in values:
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        output.append(value)
    return output


def lower_name_map(items: list[dict]) -> dict[str, dict]:
    return {item["name"].lower(): item for item in items}


def fetch_all_strains() -> dict[str, dict]:
    strains = api_call("store.product.strain.list", {"page": 1, "pageSize": 1000000})["data"]
    return lower_name_map(strains)


def fetch_groups(group_ids: list[int]) -> dict[int, dict]:
    groups = {}
    for group_id in sorted(group_ids):
        groups[group_id] = api_call("store.product.group.get", {"id": group_id})
    return groups


def fetch_exact_strain(name: str) -> dict | None:
    matches = api_call("store.product.strain.list", {"page": 1, "pageSize": 1000000, "query": name})["data"]
    for item in matches:
        if item["name"].lower() == name.lower():
            return item
    return None


def fetch_exact_effect(name: str) -> dict | None:
    for item in api_call("store.product.effect.list", {"query": name}):
        if item["name"].lower() == name.lower():
            return item
    return None


def fetch_exact_strain_flavor(name: str) -> dict | None:
    for item in api_call("store.product.strain.flavor.list", {"query": name}):
        if item["name"].lower() == name.lower():
            return item
    return None


def retry_exact_lookup(fetcher, name: str, *, attempts: int = 5, delay_s: float = 0.5):
    for attempt in range(attempts):
        row = fetcher(name)
        if row:
            return row
        if attempt + 1 < attempts:
            time.sleep(delay_s)
    return None


def switch_to_state_context() -> dict:
    return api_call("store.auth.dealer.set", {"dealerId": STATE_DEALER_ID})


def collapse_report_rows(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    actionable_by_group: dict[int, list[dict]] = defaultdict(list)
    skipped_rows = []

    for row in rows:
        group_id = int(row["groupId"])
        product_id = int(row["productId"])
        skip_reason = None
        if row["leaflyStatus"] not in ACTIONABLE_STATUSES:
            skip_reason = f"status:{row['leaflyStatus']}"
        elif row["displayStrain"] == "No strain action":
            skip_reason = "no-strain-action"

        if skip_reason:
            skipped_rows.append(
                {
                    "groupId": group_id,
                    "productId": product_id,
                    "groupName": row["groupName"],
                    "productName": row["productName"],
                    "status": row["leaflyStatus"],
                    "reason": skip_reason,
                }
            )
            continue

        actionable_by_group[group_id].append(row)

    actions = []
    for group_id in sorted(actionable_by_group):
        group_rows = actionable_by_group[group_id]
        normalized_signatures = {
            json.dumps(
                {
                    "displayStrain": row["displayStrain"],
                    "status": row["leaflyStatus"],
                    "effects": row["effects"],
                    "flavors": row["flavors"],
                    "terpenes": row["terpenes"],
                    "sourceNote": row["sourceNote"],
                },
                sort_keys=True,
            )
            for row in group_rows
        }
        if len(normalized_signatures) != 1:
            raise RuntimeError(f"Conflicting actionable rows for group {group_id}: {normalized_signatures}")

        exemplar = group_rows[0]
        actions.append(
            {
                "groupId": group_id,
                "groupName": exemplar["groupName"],
                "status": exemplar["leaflyStatus"],
                "displayStrain": exemplar["displayStrain"],
                "effects": exemplar["effects"],
                "flavors": exemplar["flavors"],
                "terpenes": exemplar["terpenes"],
                "sourceNote": exemplar["sourceNote"],
                "availableQtyTotal": sum(float(row.get("availableQty") or 0) for row in group_rows),
                "variantRows": [
                    {
                        "productId": int(row["productId"]),
                        "productName": row["productName"],
                        "availableQty": float(row.get("availableQty") or 0),
                    }
                    for row in sorted(group_rows, key=lambda item: (-float(item.get("availableQty") or 0), int(item["productId"])))
                ],
            }
        )

    return actions, skipped_rows


def determine_group_target_mode(current_strain_name: str | None, target_strain_name: str, target_exists: bool, normalized_group_name: str) -> str:
    if current_strain_name == target_strain_name:
        return "current"
    if current_strain_name in analysis.GENERIC_STRAIN_NAMES:
        return "attach_existing" if target_exists else "new_required"
    if current_strain_name == analysis.GROUP_EQUIVALENT_STRAINS.get(normalized_group_name):
        return "current_equivalent"
    if target_exists:
        return "attach_existing"
    return "new_required"


def build_detailed_plan(actions: list[dict], live_groups: dict[int, dict], strains_by_name: dict[str, dict]) -> list[dict]:
    detailed_actions = []

    for action in actions:
        group = live_groups[action["groupId"]]
        current_strain_name = (group.get("strain") or {}).get("name")
        normalized_group_name = analysis.normalize_group_name(group["name"])
        target_strain_name = action["displayStrain"]

        if normalized_group_name in analysis.INFERENCE:
            inference = analysis.INFERENCE[normalized_group_name]
            group_target_mode = inference["group_target_mode"]
            prevalence_name = inference.get("prevalence")
        else:
            target_strain_row = strains_by_name.get(target_strain_name.lower())
            verified = analysis.VERIFIED_STRAIN_LEAFLY.get(target_strain_name, {})
            group_target_mode = determine_group_target_mode(
                current_strain_name,
                target_strain_name,
                target_strain_row is not None,
                normalized_group_name,
            )
            prevalence_name = verified.get("prevalence") or ((target_strain_row or {}).get("prevalence") or {}).get("name")

        detailed_actions.append(
            {
                **action,
                "currentGroupStrain": current_strain_name,
                "groupTargetMode": group_target_mode,
                "targetStrain": target_strain_name,
                "targetPrevalence": prevalence_name,
                "currentEffects": analysis.name_list(group.get("effects", [])),
                "currentFlavorings": analysis.name_list(group.get("flavorings", [])),
                "currentScents": analysis.name_list(group.get("scents", [])),
            }
        )

    return detailed_actions


def plan_signature(actions: list[dict]) -> str:
    serialized = json.dumps(
        [
            {
                "groupId": action["groupId"],
                "status": action["status"],
                "targetStrain": action["targetStrain"],
                "groupTargetMode": action["groupTargetMode"],
                "targetPrevalence": action["targetPrevalence"],
                "effects": action["effects"],
                "flavors": action["flavors"],
                "terpenes": action["terpenes"],
            }
            for action in actions
        ],
        sort_keys=True,
    )
    return hashlib.sha256(serialized.encode()).hexdigest()


def initialize_results(plan: dict) -> dict:
    if RESULTS_PATH.exists():
        previous = read_json(RESULTS_PATH)
        if previous.get("planSignature") == plan["planSignature"] and previous.get("runStatus") != "completed":
            previous["groups"] = [item for item in previous.get("groups", []) if item.get("result") != "failed"]
            previous["runStatus"] = "in_progress"
            previous["lastUpdatedAt"] = now_iso()
            return previous

    return {
        "startedAt": now_iso(),
        "lastUpdatedAt": now_iso(),
        "runStatus": "in_progress",
        "sourceReportPath": str(REPORT_PATH),
        "planPath": str(PLAN_PATH),
        "planSignature": plan["planSignature"],
        "reportRegeneratedAt": plan["reportRegeneratedAt"],
        "stateDealerId": STATE_DEALER_ID,
        "stateDealerName": STATE_DEALER_NAME,
        "summary": {
            "actionableGroupCount": plan["summary"]["actionableGroupCount"],
            "skippedRowCount": plan["summary"]["skippedRowCount"],
            "completedGroupCount": 0,
            "updatedGroupCount": 0,
            "unchangedGroupCount": 0,
            "skippedGroupCount": 0,
            "failureCount": 0,
            "createdEffects": 0,
            "createdStrainFlavors": 0,
            "createdStrains": 0,
            "editedStrains": 0,
        },
        "created": {
            "effects": [],
            "strainFlavors": [],
            "strains": [],
        },
        "groups": [],
        "skippedRows": plan["skippedRows"],
    }


def persist_results(results: dict) -> None:
    results["lastUpdatedAt"] = now_iso()
    results["summary"]["completedGroupCount"] = len(results["groups"])
    results["summary"]["updatedGroupCount"] = sum(1 for item in results["groups"] if item["result"] == "updated")
    results["summary"]["unchangedGroupCount"] = sum(1 for item in results["groups"] if item["result"] == "unchanged")
    results["summary"]["skippedGroupCount"] = sum(1 for item in results["groups"] if item["result"] == "skipped")
    results["summary"]["failureCount"] = sum(1 for item in results["groups"] if item["result"] == "failed")
    results["summary"]["createdEffects"] = len(results["created"]["effects"])
    results["summary"]["createdStrainFlavors"] = len(results["created"]["strainFlavors"])
    results["summary"]["createdStrains"] = len(results["created"]["strains"])
    results["summary"]["editedStrains"] = sum(1 for item in results["groups"] if item.get("strainRecordEdited"))
    write_json(RESULTS_PATH, results)


def completed_group_ids(results: dict) -> set[int]:
    return {int(item["groupId"]) for item in results["groups"] if item["result"] in {"updated", "unchanged", "skipped"}}


def ensure_prevalence_id(prevalence_name: str | None, prevalence_by_name: dict[str, dict]) -> int | None:
    if not prevalence_name:
        return None
    prevalence = prevalence_by_name.get(prevalence_name.lower())
    if not prevalence:
        raise SkipGroup(f"Missing prevalence dictionary row for `{prevalence_name}`")
    return int(prevalence["id"])


def ensure_effect_rows(names: list[str], effect_by_name: dict[str, dict], positive_effect_category_id: int, created_effects: list[dict]) -> list[dict]:
    rows = []
    for name in dedupe_preserve_order(names):
        key = name.lower()
        row = effect_by_name.get(key) or retry_exact_lookup(fetch_exact_effect, name, attempts=2, delay_s=0.25)
        if not row:
            try:
                api_call("store.product.effect.add", {"name": name, "categoryId": positive_effect_category_id})
            except Exception:
                row = retry_exact_lookup(fetch_exact_effect, name)
                if not row:
                    raise
            else:
                row = retry_exact_lookup(fetch_exact_effect, name)
            if not row:
                raise RuntimeError(f"Unable to resolve effect after create: {name}")
            effect_by_name[key] = row
            created_effects.append({"id": int(row["id"]), "name": row["name"]})
        else:
            effect_by_name[key] = row
        rows.append(effect_by_name[key])
    return rows


def ensure_strain_flavor_rows(names: list[str], flavor_by_name: dict[str, dict], created_flavors: list[dict]) -> list[dict]:
    rows = []
    for name in dedupe_preserve_order(names):
        key = name.lower()
        row = flavor_by_name.get(key) or retry_exact_lookup(fetch_exact_strain_flavor, name, attempts=2, delay_s=0.25)
        if not row:
            try:
                api_call("store.product.strain.flavor.add", {"name": name})
            except Exception:
                row = retry_exact_lookup(fetch_exact_strain_flavor, name)
                if not row:
                    raise
            else:
                row = retry_exact_lookup(fetch_exact_strain_flavor, name)
            if not row:
                raise RuntimeError(f"Unable to resolve strain flavor after create: {name}")
            flavor_by_name[key] = row
            created_flavors.append({"id": int(row["id"]), "name": row["name"]})
        else:
            flavor_by_name[key] = row
        rows.append(flavor_by_name[key])
    return rows


def resolve_terpene_rows(names: list[str], terpene_by_name: dict[str, dict]) -> list[dict]:
    rows = []
    missing = []
    for name in dedupe_preserve_order(names):
        row = terpene_by_name.get(name.lower())
        if not row:
            missing.append(name)
            continue
        rows.append(row)
    if missing:
        raise SkipGroup(
            "Missing terpene dictionary rows with no confirmed create API: " + ", ".join(missing)
        )
    return rows


def merge_existing_and_target_ids(existing_rows: list[dict], target_rows: list[dict]) -> list[int]:
    merged_ids = []
    seen = set()
    for item in list(existing_rows or []) + list(target_rows or []):
        item_id = int(item["id"])
        if item_id in seen:
            continue
        seen.add(item_id)
        merged_ids.append(item_id)
    return merged_ids


def ensure_target_strain(
    action: dict,
    strains_by_name: dict[str, dict],
    prevalence_by_name: dict[str, dict],
    flavor_by_name: dict[str, dict],
    terpene_by_name: dict[str, dict],
    created_flavors: list[dict],
    created_strains: list[dict],
) -> tuple[dict, bool, list[str], list[str]]:
    target_name = action["targetStrain"]
    prevalence_id = ensure_prevalence_id(action["targetPrevalence"], prevalence_by_name)
    target_flavor_rows = ensure_strain_flavor_rows(action["flavors"], flavor_by_name, created_flavors)
    target_terpene_rows = resolve_terpene_rows(action["terpenes"], terpene_by_name)

    existing = strains_by_name.get(target_name.lower()) or retry_exact_lookup(fetch_exact_strain, target_name, attempts=2, delay_s=0.25)
    edited = False

    if not existing:
        params = {
            "name": target_name,
        }
        if prevalence_id is not None:
            params["prevalenceId"] = prevalence_id
        if target_flavor_rows:
            params["flavorIds"] = [int(item["id"]) for item in target_flavor_rows]
        if target_terpene_rows:
            params["terpeneIds"] = [int(item["id"]) for item in target_terpene_rows]
        try:
            api_call("store.product.strain.add", params)
        except Exception:
            existing = retry_exact_lookup(fetch_exact_strain, target_name)
            if not existing:
                raise
        else:
            existing = retry_exact_lookup(fetch_exact_strain, target_name)
        if not existing:
            raise RuntimeError(f"Unable to resolve newly created strain `{target_name}`")
        strains_by_name[target_name.lower()] = existing
        created_strains.append({"id": int(existing["id"]), "name": existing["name"]})
        return existing, True, [item["name"] for item in target_flavor_rows], [item["name"] for item in target_terpene_rows]

    strains_by_name[target_name.lower()] = existing
    desired_flavor_ids = merge_existing_and_target_ids(existing.get("flavors", []), target_flavor_rows)
    desired_terpene_ids = merge_existing_and_target_ids(existing.get("terpenes", []), target_terpene_rows)
    current_prevalence_id = int(existing["prevalence"]["id"]) if existing.get("prevalence") else None
    edit_params = {"id": int(existing["id"])}

    if prevalence_id is not None and current_prevalence_id != prevalence_id:
        edit_params["prevalenceId"] = prevalence_id
    if [int(item["id"]) for item in existing.get("flavors", [])] != desired_flavor_ids:
        edit_params["flavorIds"] = desired_flavor_ids
    if [int(item["id"]) for item in existing.get("terpenes", [])] != desired_terpene_ids:
        edit_params["terpeneIds"] = desired_terpene_ids

    if len(edit_params) > 1:
        api_call("store.product.strain.edit", edit_params)
        existing = retry_exact_lookup(fetch_exact_strain, target_name)
        if not existing:
            raise RuntimeError(f"Unable to re-read strain after edit: `{target_name}`")
        strains_by_name[target_name.lower()] = existing
        edited = True

    return existing, edited, [item["name"] for item in target_flavor_rows], [item["name"] for item in target_terpene_rows]


def group_snapshot(group: dict) -> dict:
    return {
        "id": int(group["id"]),
        "fullName": group.get("fullName"),
        "strain": group.get("strain"),
        "effects": group.get("effects", []),
        "flavorings": group.get("flavorings", []),
        "scents": group.get("scents", []),
    }


def process_group_action(
    action: dict,
    strains_by_name: dict[str, dict],
    prevalence_by_name: dict[str, dict],
    effect_by_name: dict[str, dict],
    positive_effect_category_id: int,
    flavor_by_name: dict[str, dict],
    terpene_by_name: dict[str, dict],
    created_trackers: dict[str, list[dict]],
) -> dict:
    group_before = api_call("store.product.group.get", {"id": action["groupId"]})
    before_snapshot = group_snapshot(group_before)
    current_strain = group_before.get("strain") or {}
    current_strain_name = current_strain.get("name")
    current_strain_id = int(current_strain["id"]) if current_strain.get("id") else None

    target_strain_row, strain_record_edited, resolved_flavors, resolved_terpenes = ensure_target_strain(
        action,
        strains_by_name,
        prevalence_by_name,
        flavor_by_name,
        terpene_by_name,
        created_trackers["strainFlavors"],
        created_trackers["strains"],
    )

    if action["groupTargetMode"] in {"current", "current_equivalent"}:
        target_strain_id = current_strain_id or int(target_strain_row["id"])
    else:
        target_strain_id = int(target_strain_row["id"])

    effect_rows = ensure_effect_rows(
        action["effects"],
        effect_by_name,
        positive_effect_category_id,
        created_trackers["effects"],
    )
    desired_effect_ids = merge_existing_and_target_ids(group_before.get("effects", []), effect_rows)
    current_effect_ids = [int(item["id"]) for item in group_before.get("effects", [])]

    group_edit_params = {"id": action["groupId"]}
    if target_strain_id and current_strain_id != target_strain_id:
        group_edit_params["strainId"] = target_strain_id
    if current_effect_ids != desired_effect_ids:
        group_edit_params["effectIds"] = desired_effect_ids

    group_edit_applied = False
    if len(group_edit_params) > 1:
        api_call("store.product.group.edit", group_edit_params)
        group_edit_applied = True

    group_after = api_call("store.product.group.get", {"id": action["groupId"]})
    after_snapshot = group_snapshot(group_after)
    result = "updated" if group_edit_applied or strain_record_edited else "unchanged"

    return {
        "groupId": action["groupId"],
        "groupName": action["groupName"],
        "status": action["status"],
        "result": result,
        "groupTargetMode": action["groupTargetMode"],
        "currentGroupStrain": current_strain_name,
        "targetStrain": action["targetStrain"],
        "targetPrevalence": action["targetPrevalence"],
        "targetEffects": action["effects"],
        "targetFlavors": action["flavors"],
        "targetTerpenes": action["terpenes"],
        "resolvedStrainId": int(target_strain_row["id"]),
        "resolvedFlavorNames": resolved_flavors,
        "resolvedTerpeneNames": resolved_terpenes,
        "groupEditApplied": group_edit_applied,
        "groupEditParams": group_edit_params if group_edit_applied else None,
        "strainRecordEdited": strain_record_edited,
        "variantRows": action["variantRows"],
        "sourceNote": action["sourceNote"],
        "before": before_snapshot,
        "after": after_snapshot,
    }


def main() -> None:
    print("Regenerating in-stock attribute report from Midtown site context...")
    analysis.main()
    report_rows = read_json(REPORT_PATH)
    collapsed_actions, skipped_rows = collapse_report_rows(report_rows)

    print("Switching to state-level catalog context...")
    switch_to_state_context()
    live_groups = fetch_groups([action["groupId"] for action in collapsed_actions])
    strains_by_name = fetch_all_strains()
    detailed_actions = build_detailed_plan(collapsed_actions, live_groups, strains_by_name)
    signature = plan_signature(detailed_actions)

    plan = {
        "generatedAt": now_iso(),
        "reportRegeneratedAt": now_iso(),
        "sourceReportPath": str(REPORT_PATH),
        "stateDealerId": STATE_DEALER_ID,
        "stateDealerName": STATE_DEALER_NAME,
        "summary": {
            "actionableGroupCount": len(detailed_actions),
            "skippedRowCount": len(skipped_rows),
            "statusCounts": dict(Counter(action["status"] for action in detailed_actions)),
            "targetModeCounts": dict(Counter(action["groupTargetMode"] for action in detailed_actions)),
        },
        "planSignature": signature,
        "actions": detailed_actions,
        "skippedRows": skipped_rows,
    }
    write_json(PLAN_PATH, plan)

    print("Preloading reusable dictionaries...")
    prevalence_by_name = lower_name_map(api_call("store.product.strain.prevalence.list", {}))
    effect_categories = lower_name_map(api_call("store.product.effect.category.list", {}))
    effect_by_name = lower_name_map(api_call("store.product.effect.list", {}))
    flavor_by_name = lower_name_map(api_call("store.product.strain.flavor.list", {}))
    terpene_by_name = lower_name_map(api_call("store.product.strain.terpene.list", {}))
    positive_effect_category = effect_categories.get(POSITIVE_EFFECT_CATEGORY_NAME.lower())
    if not positive_effect_category:
        raise RuntimeError(f"Missing `{POSITIVE_EFFECT_CATEGORY_NAME}` effect category")

    results = initialize_results(plan)
    persist_results(results)
    done_group_ids = completed_group_ids(results)
    created_trackers = results["created"]

    for index, action in enumerate(detailed_actions, start=1):
        if action["groupId"] in done_group_ids:
            continue
        print(f"[{index}/{len(detailed_actions)}] {action['groupId']} {action['groupName']}")
        try:
            record = process_group_action(
                action,
                strains_by_name,
                prevalence_by_name,
                effect_by_name,
                int(positive_effect_category["id"]),
                flavor_by_name,
                terpene_by_name,
                created_trackers,
            )
        except SkipGroup as exc:
            record = {
                "groupId": action["groupId"],
                "groupName": action["groupName"],
                "status": action["status"],
                "result": "skipped",
                "reason": str(exc),
                "groupTargetMode": action["groupTargetMode"],
                "targetStrain": action["targetStrain"],
                "targetPrevalence": action["targetPrevalence"],
                "targetEffects": action["effects"],
                "targetFlavors": action["flavors"],
                "targetTerpenes": action["terpenes"],
                "variantRows": action["variantRows"],
                "sourceNote": action["sourceNote"],
            }
        except Exception as exc:
            record = {
                "groupId": action["groupId"],
                "groupName": action["groupName"],
                "status": action["status"],
                "result": "failed",
                "reason": str(exc),
                "groupTargetMode": action["groupTargetMode"],
                "targetStrain": action["targetStrain"],
                "targetPrevalence": action["targetPrevalence"],
                "targetEffects": action["effects"],
                "targetFlavors": action["flavors"],
                "targetTerpenes": action["terpenes"],
                "variantRows": action["variantRows"],
                "sourceNote": action["sourceNote"],
            }
            results["groups"].append(record)
            persist_results(results)
            raise

        results["groups"].append(record)
        persist_results(results)

    if any(item["result"] == "failed" for item in results["groups"]):
        results["runStatus"] = "failed"
    elif any(item["result"] == "skipped" for item in results["groups"]):
        results["runStatus"] = "completed_with_skips"
    else:
        results["runStatus"] = "completed"
    results["finishedAt"] = now_iso()
    persist_results(results)
    print(f"Finished with status {results['runStatus']}")


if __name__ == "__main__":
    main()
