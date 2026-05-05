# DEPRECATED: This script directly mutates Sweed screen banners and is older than one week.
# All future screen-banner development and maintenance must be done in Helios under
# helios. Treat this file as historical reference only; do not
# extend it, do not run it for live banner work, and do not import from it.
# See HOW_HELIOS_WORKS.md and docs/sweed/marketing/screens-and-banners.md.

#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


HELPER_PATH = Path(
    "/Users/dave/tmp/scratch/fbnyc/sweed/automation/customers/segmentation/2026-04-11/import_sweed_customers_to_crm.py"
)
DEFAULT_OUTPUT_PATH = Path(__file__).resolve().parent / "midtown_flower_specials_screen_banner_results.json"
DEFAULT_DELAY_SECONDS = 0.5
CAMPAIGN_LIST_PAGE_SIZE = 300
ACTION_LIST_PAGE_SIZE = 200
SELECTOR_LIST_PAGE_SIZE = 1000


@dataclass(frozen=True)
class StoreContext:
    dealer_id: int
    dealer_name: str
    store_id: int
    store_name: str


@dataclass(frozen=True)
class SourceSelectorSpec:
    label: str
    action_id: str
    preferred_size_id: int


MIDTOWN_CONTEXT = StoreContext(
    dealer_id=210705,
    dealer_name="Freshly Baked NYC - Midtown",
    store_id=623,
    store_name="Freshly Baked NYC - Midtown",
)

TARGET_CAMPAIGN_NAME = "260419 - velocity"
TARGET_ACTION_NAME = "Midtown - Screen Flower Specials"
TARGET_ACTION_SHORT_NAME = "Flower Specials"
TARGET_ACTION_DESCRIPTION = (
    "Hidden zero-loyalty convenience action used only for Midtown in-store TV banner product pools."
)
TARGET_BANNER_NAME = "Flower Specials"
TARGET_BANNER_DURATION = 5
TARGET_SCREEN_IDS = [276, 250, 251, 252]
TARGET_PRODUCTS_DISPLAYED = 3

SOURCE_SELECTORS = [
    SourceSelectorSpec(label="Herb 28g", action_id="42661", preferred_size_id=854),
    SourceSelectorSpec(label="Weedubest 28g", action_id="42662", preferred_size_id=854),
    SourceSelectorSpec(label="Find. 14g", action_id="42663", preferred_size_id=853),
    SourceSelectorSpec(label="Weedubest 3.5g", action_id="42702", preferred_size_id=850),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create or reuse a hidden Midtown zero-loyalty action that aggregates the current flower-special "
            "selector pools, then attach a promo-backed product-menu banner to the active Midtown screens."
        )
    )
    parser.add_argument("--auth-token", help="Live Sweed auth token. If omitted, the script extracts one from the newest local HAR.")
    parser.add_argument(
        "--har-path",
        type=Path,
        help="Optional HAR path to extract the auth token from. Defaults to the newest local prime.sweedpos.com HAR.",
    )
    parser.add_argument(
        "--delay-seconds",
        type=float,
        default=DEFAULT_DELAY_SECONDS,
        help=f"Delay between live mutations. Defaults to {DEFAULT_DELAY_SECONDS} seconds.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_PATH,
        help=f"Where to write the JSON execution summary. Defaults to {DEFAULT_OUTPUT_PATH.name} in this folder.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Perform the live action/banner writes. Without this flag the script only records the intended target state.",
    )
    return parser.parse_args()


def load_helper() -> Any:
    spec = importlib.util.spec_from_file_location("sweed_helper", HELPER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load helper from {HELPER_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(HELPER_PATH.parent))
    spec.loader.exec_module(module)
    return module


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def today_string() -> str:
    return date.today().isoformat()


def today_start_iso() -> str:
    return f"{today_string()}T00:00:00Z"


def print_progress(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def maybe_wait(delay_seconds: float) -> None:
    if delay_seconds > 0:
        time.sleep(delay_seconds)


def load_auth_token(args: argparse.Namespace, helper: Any) -> str:
    env_token = os.environ.get("SWEED_AUTH_TOKEN")
    if env_token:
        return env_token

    if args.auth_token:
        return args.auth_token

    if args.har_path is not None:
        return helper.extract_auth_token(args.har_path)

    return helper.extract_auth_token(helper.find_latest_har())


def switch_context(helper: Any, auth: str, ctx: StoreContext, *, attempts: int = 5) -> dict[str, Any]:
    last_error: Exception | None = None
    for _ in range(attempts):
        try:
            result = helper.rpc(auth, "store.auth.dealer.set", {"dealerId": ctx.dealer_id}, timeout=120)
            dealer = result.get("dealer") or {}
            store = result.get("store") or {}
            if dealer.get("id") != ctx.dealer_id:
                raise RuntimeError(f"Expected dealer {ctx.dealer_id}, got {dealer}")
            if store.get("id") != ctx.store_id:
                raise RuntimeError(f"Expected store {ctx.store_id}, got {store}")
            return result
        except Exception as exc:  # noqa: PERF203 - bounded retry loop for shared-session drift
            last_error = exc
            time.sleep(1)
    raise last_error or RuntimeError(f"Unable to switch into {ctx.dealer_name}")


def midtown_read_rpc(helper: Any, auth: str, name: str, params: dict[str, Any] | None = None) -> Any:
    last_error: Exception | None = None
    for _ in range(5):
        try:
            switch_context(helper, auth, MIDTOWN_CONTEXT)
            return helper.rpc(auth, name, params, timeout=120)
        except Exception as exc:  # noqa: PERF203 - bounded retry loop for shared-session drift
            last_error = exc
            time.sleep(1)
    raise last_error or RuntimeError(f"Read RPC {name} failed")


def midtown_write_rpc(helper: Any, auth: str, name: str, params: dict[str, Any] | None = None) -> Any:
    switch_context(helper, auth, MIDTOWN_CONTEXT)
    return helper.rpc(auth, name, params, timeout=120)


def list_campaigns(helper: Any, auth: str) -> list[dict[str, Any]]:
    page = 1
    rows: list[dict[str, Any]] = []
    while True:
        result = midtown_read_rpc(helper, auth, "store.promo.campaign.list", {"page": page, "pageSize": CAMPAIGN_LIST_PAGE_SIZE})
        current_rows = result.get("data") or []
        rows.extend(current_rows)
        if not current_rows or len(current_rows) < CAMPAIGN_LIST_PAGE_SIZE:
            return rows
        page += 1


def find_site_campaign(helper: Any, auth: str, name: str) -> dict[str, Any] | None:
    for row in list_campaigns(helper, auth):
        originator = row.get("originator") or {}
        if row.get("name") == name and originator.get("id") == MIDTOWN_CONTEXT.dealer_id:
            return row
    return None


def list_actions(helper: Any, auth: str, campaign_id: str) -> list[dict[str, Any]]:
    page = 1
    rows: list[dict[str, Any]] = []
    while True:
        result = midtown_read_rpc(
            helper,
            auth,
            "store.promo.action.list",
            {"campaignId": campaign_id, "page": page, "pageSize": ACTION_LIST_PAGE_SIZE},
        )
        current_rows = result.get("data") or []
        rows.extend(current_rows)
        if not current_rows or len(current_rows) < ACTION_LIST_PAGE_SIZE:
            return rows
        page += 1


def list_get_selectors(helper: Any, auth: str, action_id: str) -> list[dict[str, Any]]:
    result = midtown_read_rpc(
        helper,
        auth,
        "store.promo.selector.get.list",
        {"actionId": action_id, "page": 1, "pageSize": SELECTOR_LIST_PAGE_SIZE},
    )
    return result.get("data") or []


def list_screens(helper: Any, auth: str) -> list[dict[str, Any]]:
    page = 1
    page_size = 200
    rows: list[dict[str, Any]] = []
    while True:
        result = midtown_read_rpc(helper, auth, "store.screen.carousel.list", {"page": page, "pageSize": page_size})
        current_rows = result.get("data") or []
        rows.extend(current_rows)
        if not current_rows or len(current_rows) < page_size:
            return rows
        page += 1


def list_screen_banners(helper: Any, auth: str, screen_id: int) -> list[dict[str, Any]]:
    return midtown_read_rpc(helper, auth, "store.screen.carousel.banner.list", {"screenId": screen_id}) or []


def read_banner_detail(helper: Any, auth: str, banner_id: str) -> dict[str, Any]:
    return midtown_read_rpc(helper, auth, "store.screen.carousel.banner.get", {"id": banner_id})


def selector_signature_from_entities(*, brand_id: int, category_id: int, size_id: int) -> tuple[int, int, int]:
    return (brand_id, category_id, size_id)


def selector_signature(selector: dict[str, Any]) -> tuple[int, int, int]:
    brands = selector.get("brands") or []
    categories = selector.get("categories") or []
    sizes = selector.get("sizes") or []
    if len(brands) != 1 or len(categories) != 1 or len(sizes) != 1:
        raise RuntimeError(f"Selector {selector.get('id')} did not have exactly one brand, category, and size")
    return selector_signature_from_entities(
        brand_id=int(brands[0]["id"]),
        category_id=int(categories[0]["id"]),
        size_id=int(sizes[0]["id"]),
    )


def encode_blob(payload: dict[str, Any]) -> str:
    return base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()


def build_selector_data(brand: dict[str, Any], category: dict[str, Any], size: dict[str, Any]) -> str:
    return encode_blob(
        {
            "id": "__ROOT__",
            "root": True,
            "combinator": "and",
            "rules": [
                {
                    "id": str(uuid.uuid4()),
                    "new": True,
                    "field": "brandsIds",
                    "type": "multiSelect",
                    "operator": "equal",
                    "value": [{"id": int(brand["id"]), "name": brand["name"]}],
                },
                {
                    "id": str(uuid.uuid4()),
                    "new": True,
                    "field": "categoriesIds",
                    "type": "categoryMultiSelect",
                    "operator": "equal",
                    "value": [{"id": int(category["id"]), "name": category["name"]}],
                },
                {
                    "id": str(uuid.uuid4()),
                    "new": True,
                    "field": "sizesIds",
                    "type": "multiSelect",
                    "operator": "equal",
                    "value": [{"id": int(size["id"]), "name": size["name"]}],
                },
            ],
            "touched": True,
        }
    )


def resolve_source_selector_specs(helper: Any, auth: str) -> list[dict[str, Any]]:
    resolved: list[dict[str, Any]] = []
    for source in SOURCE_SELECTORS:
        detail = midtown_read_rpc(helper, auth, "store.promo.action.get", {"id": source.action_id})
        selector_pool = [*(detail.get("getSelectors") or []), *(detail.get("buySelectors") or [])]
        matches_by_signature: dict[tuple[int, int, int], dict[str, Any]] = {}
        for selector in selector_pool:
            sizes = selector.get("sizes") or []
            if len(sizes) != 1 or int(sizes[0]["id"]) != source.preferred_size_id:
                continue
            brands = selector.get("brands") or []
            categories = selector.get("categories") or []
            if len(brands) != 1 or len(categories) != 1:
                continue
            matches_by_signature[selector_signature(selector)] = selector
        matches = list(matches_by_signature.values())
        if len(matches) != 1:
            raise RuntimeError(
                f"Expected exactly one source selector for {source.label} on action {source.action_id}, found {len(matches)}"
            )
        selector = matches[0]
        resolved.append(
            {
                "label": source.label,
                "sourceActionId": source.action_id,
                "sourceActionName": detail.get("name"),
                "brand": {"id": int(selector["brands"][0]["id"]), "name": selector["brands"][0]["name"]},
                "category": {"id": int(selector["categories"][0]["id"]), "name": selector["categories"][0]["name"]},
                "size": {"id": int(selector["sizes"][0]["id"]), "name": selector["sizes"][0]["name"]},
                "sourceSelectorId": str(selector["id"]),
                "sourceSelectorProductCount": int(selector.get("productCount") or 0),
            }
        )
    return resolved


def build_action_add_payload(campaign_id: str) -> dict[str, Any]:
    return {
        "campaignId": campaign_id,
        "applicationStepId": 3,
        "applicationTargetId": 1,
        "applicationModeId": 1,
        "applicationTypeId": 1,
        "actionTypeId": 4,
        "actionMixAndMatchTypeId": 1,
        "name": TARGET_ACTION_NAME,
        "shortName": TARGET_ACTION_SHORT_NAME,
        "description": TARGET_ACTION_DESCRIPTION,
        "fromDate": today_start_iso(),
        "cronExpression": "0 0 * * * *",
        "displayInEcommerceProducts": False,
        "ecommerceDiscountMenuActionDisplayTypeId": 1,
        "ecommerceHomePageActionDisplayTypeId": 1,
        "alwaysDisplayPromotionDeals": False,
        "excludeDiscountedProducts": False,
        "includeBuySelectors": False,
        "applyToGrantedAction": False,
        "isCodeRequired": False,
        "bonusLoyaltyAmount": 0.0,
        "isBonusLoyaltyQualifying": True,
        "enabled": False,
    }


def build_action_edit_payload(action_id: str, campaign_id: str) -> dict[str, Any]:
    payload = build_action_add_payload(campaign_id)
    payload.pop("campaignId", None)
    payload["id"] = action_id
    return payload


def build_get_selector_payload(action_id: str, selector_spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "actionId": action_id,
        "applicationModeId": 2,
        "distributionLevelId": 3,
        "stackTypeId": 1,
        "selectorData": build_selector_data(selector_spec["brand"], selector_spec["category"], selector_spec["size"]),
        "brands": [selector_spec["brand"]],
        "categories": [selector_spec["category"]],
        "sizes": [selector_spec["size"]],
        "enabled": True,
    }


def ensure_hidden_action(
    helper: Any,
    auth: str,
    campaign_id: str,
    selector_specs: list[dict[str, Any]],
    *,
    apply_changes: bool,
    delay_seconds: float,
) -> dict[str, Any]:
    action_rows = list_actions(helper, auth, campaign_id)
    existing = next((row for row in action_rows if row.get("name") == TARGET_ACTION_NAME), None)
    desired_signatures = {
        selector_signature_from_entities(
            brand_id=spec["brand"]["id"],
            category_id=spec["category"]["id"],
            size_id=spec["size"]["id"],
        )
        for spec in selector_specs
    }

    if existing is None:
        if not apply_changes:
            return {
                "id": None,
                "status": "missing",
                "wouldCreateOnApply": True,
                "selectors": selector_specs,
            }
        created = midtown_write_rpc(helper, auth, "store.promo.action.add", build_action_add_payload(campaign_id))
        action_id = str(created["id"])
        maybe_wait(delay_seconds)
        for selector_spec in selector_specs:
            midtown_write_rpc(helper, auth, "store.promo.selector.get.add", build_get_selector_payload(action_id, selector_spec))
            maybe_wait(delay_seconds)
        midtown_write_rpc(helper, auth, "store.promo.action.edit", {"id": action_id, "enabled": True})
        maybe_wait(delay_seconds)
        detail = midtown_read_rpc(helper, auth, "store.promo.action.get", {"id": action_id})
        return build_action_summary(detail, selector_specs, status="created")

    action_id = str(existing["id"])
    detail = midtown_read_rpc(helper, auth, "store.promo.action.get", {"id": action_id})
    current_selectors = list_get_selectors(helper, auth, action_id)
    current_signatures = {selector_signature(selector) for selector in current_selectors}
    extra_signatures = current_signatures - desired_signatures
    if extra_signatures:
        raise RuntimeError(
            f"Existing hidden action {action_id} has unexpected extra selectors: {sorted(extra_signatures)}"
        )

    status = "unchanged"
    if apply_changes:
        if detail.get("enabled"):
            midtown_write_rpc(helper, auth, "store.promo.action.edit", {"id": action_id, "enabled": False})
            maybe_wait(delay_seconds)
        midtown_write_rpc(helper, auth, "store.promo.action.edit", build_action_edit_payload(action_id, campaign_id))
        maybe_wait(delay_seconds)
        current_selectors = list_get_selectors(helper, auth, action_id)
        current_signatures = {selector_signature(selector) for selector in current_selectors}
        missing = [spec for spec in selector_specs if selector_signature_from_entities(
            brand_id=spec["brand"]["id"],
            category_id=spec["category"]["id"],
            size_id=spec["size"]["id"],
        ) not in current_signatures]
        for selector_spec in missing:
            midtown_write_rpc(helper, auth, "store.promo.selector.get.add", build_get_selector_payload(action_id, selector_spec))
            maybe_wait(delay_seconds)
        midtown_write_rpc(helper, auth, "store.promo.action.edit", {"id": action_id, "enabled": True})
        maybe_wait(delay_seconds)
        detail = midtown_read_rpc(helper, auth, "store.promo.action.get", {"id": action_id})
        if missing or not detail.get("enabled"):
            status = "updated"
    return build_action_summary(detail, selector_specs, status=status)


def build_action_summary(detail: dict[str, Any], selector_specs: list[dict[str, Any]], *, status: str) -> dict[str, Any]:
    get_selectors = detail.get("getSelectors") or []
    selector_summaries = []
    for selector in get_selectors:
        brands = selector.get("brands") or []
        categories = selector.get("categories") or []
        sizes = selector.get("sizes") or []
        selector_summaries.append(
            {
                "id": str(selector.get("id")),
                "brand": None if not brands else brands[0],
                "category": None if not categories else categories[0],
                "size": None if not sizes else sizes[0],
                "productCount": int(selector.get("productCount") or 0),
            }
        )
    return {
        "id": str(detail.get("id")),
        "name": detail.get("name"),
        "shortName": detail.get("shortName"),
        "campaignId": str(detail.get("campaignId")),
        "enabled": bool(detail.get("enabled")),
        "displayInEcommerceProducts": bool(detail.get("displayInEcommerceProducts")),
        "ecommerceDiscountMenuActionDisplayTypeId": (detail.get("ecommerceDiscountMenuActionDisplayType") or {}).get("id"),
        "ecommerceHomePageActionDisplayTypeId": (detail.get("ecommerceHomePageActionDisplayType") or {}).get("id"),
        "bonusLoyaltyAmount": detail.get("bonusLoyaltyAmount"),
        "status": status,
        "sourceSelectorSpecs": selector_specs,
        "resolvedSelectors": selector_summaries,
    }


def add_product_menu_banner(helper: Any, auth: str, *, screen_id: int, ordering: int, promo_action_id: str) -> dict[str, Any]:
    created = midtown_write_rpc(
        helper,
        auth,
        "store.screen.carousel.banner.add",
        {
            "screenId": screen_id,
            "name": TARGET_BANNER_NAME,
            "typeId": 3,
            "enabled": False,
            "ordering": ordering,
            "fromDate": today_string(),
            "duration": TARGET_BANNER_DURATION,
            "promoActionId": promo_action_id,
            "usePromoHeader": True,
            "layoutTypeId": 2,
            "productsDisplayed": TARGET_PRODUCTS_DISPLAYED,
            "cronExpression": "0 0 * * * *",
            "showNumberOfItemsInHeader": False,
        },
    )
    return read_banner_detail(helper, auth, str(created["id"]))


def ensure_screen_banners(
    helper: Any,
    auth: str,
    promo_action_id: str,
    *,
    apply_changes: bool,
) -> list[dict[str, Any]]:
    screen_map = {int(screen["id"]): screen for screen in list_screens(helper, auth)}
    results: list[dict[str, Any]] = []
    for index, screen_id in enumerate(TARGET_SCREEN_IDS):
        screen = screen_map.get(screen_id)
        if screen is None:
            raise RuntimeError(f"Midtown screen {screen_id} was not found")
        screen_banners = list_screen_banners(helper, auth, screen_id)
        matching = [row for row in screen_banners if str(row.get("promoActionId")) == promo_action_id or row.get("name") == TARGET_BANNER_NAME]
        if len(matching) > 1:
            raise RuntimeError(f"Screen {screen_id} already has multiple candidate {TARGET_BANNER_NAME} banners")
        next_ordering = max((int(row.get("ordering") or 0) for row in screen_banners), default=0) + 1
        result: dict[str, Any] = {
            "screenId": screen_id,
            "screenName": screen.get("name"),
            "rolloutPhase": "seed" if index == 0 else "replica",
            "plannedOrdering": next_ordering,
            "banner": None,
        }
        if matching:
            detail = read_banner_detail(helper, auth, str(matching[0]["id"]))
            result["banner"] = {
                "id": str(detail["id"]),
                "name": detail.get("name"),
                "ordering": int(detail.get("ordering") or 0),
                "enabled": bool(detail.get("enabled")),
                "promoActionId": detail.get("promoActionId"),
                "totalDuration": int(detail.get("totalDuration") or 0),
                "status": "existing",
            }
            results.append(result)
            continue
        if not apply_changes:
            result["banner"] = {
                "id": None,
                "name": TARGET_BANNER_NAME,
                "ordering": next_ordering,
                "enabled": False,
                "promoActionId": promo_action_id,
                "totalDuration": None,
                "status": "planned",
            }
            results.append(result)
            continue
        detail = add_product_menu_banner(helper, auth, screen_id=screen_id, ordering=next_ordering, promo_action_id=promo_action_id)
        result["banner"] = {
            "id": str(detail["id"]),
            "name": detail.get("name"),
            "ordering": int(detail.get("ordering") or 0),
            "enabled": bool(detail.get("enabled")),
            "promoActionId": detail.get("promoActionId"),
            "totalDuration": int(detail.get("totalDuration") or 0),
            "status": "created",
        }
        results.append(result)
    return results


def main() -> int:
    args = parse_args()
    helper = load_helper()
    auth = load_auth_token(args, helper)
    initial = helper.rpc(auth, "store.auth.initial.data.get", timeout=120)
    initial_user = initial.get("user") or {}
    initial_dealer_id = initial_user.get("currentDealerId")
    initial_dealer_name = initial_user.get("currentDealerName")

    summary: dict[str, Any] = {
        "startedAt": iso_now(),
        "mode": "apply" if args.apply else "dry-run",
        "initialDealer": {"dealerId": initial_dealer_id, "dealerName": initial_dealer_name},
    }

    try:
        switch_context(helper, auth, MIDTOWN_CONTEXT)
        campaign = find_site_campaign(helper, auth, TARGET_CAMPAIGN_NAME)
        if campaign is None:
            raise RuntimeError(f"Midtown campaign {TARGET_CAMPAIGN_NAME} was not found")
        summary["campaign"] = {
            "id": str(campaign["id"]),
            "name": campaign.get("name"),
            "enabled": bool(campaign.get("enabled")),
            "fromDate": campaign.get("fromDate"),
            "toDate": campaign.get("toDate"),
        }
        selector_specs = resolve_source_selector_specs(helper, auth)
        summary["sourceSelectors"] = selector_specs
        hidden_action = ensure_hidden_action(
            helper,
            auth,
            str(campaign["id"]),
            selector_specs,
            apply_changes=args.apply,
            delay_seconds=args.delay_seconds,
        )
        summary["hiddenAction"] = hidden_action
        summary["screens"] = ensure_screen_banners(
            helper,
            auth,
            hidden_action["id"] if hidden_action.get("id") else "__MISSING__",
            apply_changes=args.apply,
        )
    finally:
        if isinstance(initial_dealer_id, int):
            try:
                helper.rpc(auth, "store.auth.dealer.set", {"dealerId": initial_dealer_id}, timeout=120)
            except Exception:
                pass

    summary["finishedAt"] = iso_now()
    args.output.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print_progress(
        f"Completed {summary['mode']} Midtown flower-specials screen-banner setup across {len(summary.get('screens', []))} screen(s). "
        f"Summary written to {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
