#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import socket
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
CAMPAIGN_LIST_PAGE_SIZE = 300
ACTION_LIST_PAGE_SIZE = 200
DEFAULT_DELAY_SECONDS = 0.5
DEFAULT_OUTPUT_PATH = Path(__file__).resolve().parent / "replace_midtown_fresh_and_intense_image_banners_with_dynamic_promo_results.json"
STATIC_CLONE_RESULTS_PATH = Path(__file__).resolve().parent / "clone_bronx_banners_to_midtown_results.json"
RUNTIME_CLONE_RESULTS_DIRECTORY = Path(__file__).resolve().parents[1] / "helios/runtime-artifacts/screens"
PRODUCT_MENU_TYPE_ID = 3
CARD_LAYOUT_TYPE_ID = 2
STANDARD_PRODUCTS_DISPLAYED = 3

CAMPAIGN_NAME = "New Arrivals"
CAMPAIGN_DESCRIPTION = "See what's new to the menu and moving quickly!"
CAMPAIGN_FROM_DATE = "2025-09-05T00:00:00Z"

ACTION_NAME = "Fresh & Intense"
ACTION_SHORT_NAME = "Fresh & INTENSE"
ACTION_DESCRIPTION = "These are our newest, strongest, and most interesting products generating lots of buzz!"
ACTION_FROM_DATE = "2025-09-05T00:00:00Z"

FRESH_BANNER_NAME = "Fresh & INTENSE"
RECEPTION_MAX_DAYS = 15
THC_MIN_PERCENT = 40

ORIGINAL_GETADDRINFO = socket.getaddrinfo


def ipv4_first_getaddrinfo(host: str, port: int, family: int = 0, type: int = 0, proto: int = 0, flags: int = 0):
    if host == "prime.sweedpos.com":
        family = socket.AF_INET
    return ORIGINAL_GETADDRINFO(host, port, family, type, proto, flags)


socket.getaddrinfo = ipv4_first_getaddrinfo


@dataclass(frozen=True)
class StoreContext:
    dealer_id: int
    dealer_name: str
    store_id: int
    store_name: str


MIDTOWN_CONTEXT = StoreContext(
    dealer_id=210705,
    dealer_name="Freshly Baked NYC - Midtown",
    store_id=623,
    store_name="Freshly Baked NYC - Midtown",
)


CATEGORY_VALUES = [
    {"id": 1089, "name": "Concentrates"},
    {"id": 1121, "name": "Applicators/Darts", "parentId": 1089},
    {"id": 1122, "name": "Badder", "parentId": 1089},
    {"id": 1123, "name": "Diamonds", "parentId": 1089},
    {"id": 1124, "name": "Hash", "parentId": 1089},
    {"id": 2044, "name": "Kief", "parentId": 1089},
    {"id": 1125, "name": "Live Resin", "parentId": 1089},
    {"id": 1126, "name": "Live Rosin", "parentId": 1089},
    {"id": 1127, "name": "Shatter", "parentId": 1089},
    {"id": 2051, "name": "Sugar", "parentId": 1089},
    {"id": 1086, "name": "Edibles"},
    {"id": 1240, "name": "Baked Goods", "parentId": 1086},
    {"id": 1104, "name": "Beverages", "parentId": 1086},
    {"id": 1105, "name": "Capsules/Tablets", "parentId": 1086},
    {"id": 1106, "name": "Chews/Gummies", "parentId": 1086},
    {"id": 1107, "name": "Chocolate", "parentId": 1086},
    {"id": 1094, "name": "Cooking/Baking", "parentId": 1086},
    {"id": 1108, "name": "Drinks", "parentId": 1086},
    {"id": 1109, "name": "Freeze Pops", "parentId": 1086},
    {"id": 1110, "name": "Hard Candy", "parentId": 1086},
    {"id": 1241, "name": "Tinctures", "parentId": 1086},
    {"id": 1088, "name": "Flower"},
    {"id": 1095, "name": "Infused Flower", "parentId": 1088},
    {"id": 1995, "name": "Infused Pre-Ground Flower", "parentId": 1088},
    {"id": 1904, "name": "Pre-Ground Flower", "parentId": 1088},
    {"id": 1120, "name": "Pre-Packaged Flower", "parentId": 1088},
    {"id": 1085, "name": "Pre-Rolls"},
    {"id": 1102, "name": "Infused Pre-Roll", "parentId": 1085},
    {"id": 1103, "name": "Infused Pre-Roll Multi-Pack", "parentId": 1085},
    {"id": 1093, "name": "Multi-Pack", "parentId": 1085},
    {"id": 1092, "name": "Single", "parentId": 1085},
    {"id": 1090, "name": "Topicals"},
    {"id": 1128, "name": "Transdermals", "parentId": 1090},
    {"id": 1087, "name": "Vapes"},
    {"id": 2021, "name": "All-In-One", "parentId": 1087},
    {"id": 1111, "name": "Cartridge", "parentId": 1087},
    {"id": 1112, "name": "Disposable", "parentId": 1087},
    {"id": 1113, "name": "Live Resin Cartridge", "parentId": 1087},
    {"id": 1114, "name": "Live Resin Disposable", "parentId": 1087},
    {"id": 1115, "name": "Live Resin Pod", "parentId": 1087},
    {"id": 1116, "name": "Live Rosin Cartridge", "parentId": 1087},
    {"id": 1117, "name": "Live Rosin Disposable", "parentId": 1087},
    {"id": 1118, "name": "Live Rosin Pod", "parentId": 1087},
    {"id": 1119, "name": "Pod", "parentId": 1087},
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Replace Midtown Fresh & INTENSE image fallback banners with the documented selector-driven promo-backed "
            "product-menu banners. Without --apply the script only records the action readiness and the replacement plan."
        )
    )
    parser.add_argument("--auth-token", help="Live Sweed auth token. If omitted, the script extracts one from the newest local HAR.")
    parser.add_argument(
        "--har-path",
        type=Path,
        help="Optional HAR path to extract the auth token from. Defaults to the newest local prime.sweedpos.com HAR.",
    )
    parser.add_argument(
        "--clone-results-path",
        type=Path,
        help=(
            "Optional clone artifact path. Defaults to the newest apply artifact from Helios runtime-artifacts/screens/, "
            "falling back to clone_bronx_banners_to_midtown_results.json in this folder."
        ),
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
        help="Perform the live replacement writes. Without this flag the script only records the replacement plan.",
    )
    return parser.parse_args()


def latest_clone_results_path(explicit_path: Path | None) -> Path:
    if explicit_path is not None:
        return explicit_path

    candidates: list[Path] = []
    if RUNTIME_CLONE_RESULTS_DIRECTORY.exists():
        candidates.extend(RUNTIME_CLONE_RESULTS_DIRECTORY.glob("screens-bronx-midtown-image-clone-job-*.json"))
    if STATIC_CLONE_RESULTS_PATH.exists():
        candidates.append(STATIC_CLONE_RESULTS_PATH)

    for path in sorted(candidates, key=lambda candidate: candidate.stat().st_mtime, reverse=True):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if payload.get("mode") != "apply":
            continue
        screens = payload.get("midtownCloneRun", {}).get("screens", [])
        if any(screen.get("created") for screen in screens):
            return path

    raise SystemExit(
        "No Bronx-to-Midtown apply clone artifact was found. Pass --clone-results-path or run the image fallback clone first."
    )


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


def print_progress(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def maybe_wait(delay_seconds: float = DEFAULT_DELAY_SECONDS) -> None:
    if delay_seconds > 0:
        time.sleep(delay_seconds)


def load_auth_token(args: argparse.Namespace, helper: Any) -> str:
    env_token = os.environ.get("SWEED_AUTH_TOKEN")
    if env_token:
        return env_token

    if args.auth_token:
        return args.auth_token

    har_path = args.har_path or helper.find_latest_har()
    return helper.extract_auth_token(har_path)


def switch_context(helper: Any, auth: str, ctx: StoreContext) -> dict[str, Any]:
    result = helper.rpc(auth, "store.auth.dealer.set", {"dealerId": ctx.dealer_id}, timeout=120)
    dealer = result.get("dealer") or {}
    store = result.get("store") or {}
    if dealer.get("id") != ctx.dealer_id:
        raise RuntimeError(f"Expected dealer {ctx.dealer_id}, got {dealer}")
    if store.get("id") != ctx.store_id:
        raise RuntimeError(f"Expected store {ctx.store_id}, got {store}")
    return result


def find_site_campaign(helper: Any, auth: str, ctx: StoreContext, name: str) -> dict[str, Any] | None:
    page = 1
    while True:
        result = helper.rpc(
            auth,
            "store.promo.campaign.list",
            {"page": page, "pageSize": CAMPAIGN_LIST_PAGE_SIZE},
            timeout=120,
        )
        rows = result.get("data") or []
        for row in rows:
            originator = row.get("originator") or {}
            if row.get("name") == name and originator.get("id") == ctx.dealer_id:
                return row
        if not rows or len(rows) < CAMPAIGN_LIST_PAGE_SIZE:
            return None
        page += 1


def campaign_payload(*, enabled: bool) -> dict[str, Any]:
    return {
        "name": CAMPAIGN_NAME,
        "description": CAMPAIGN_DESCRIPTION,
        "fromDate": CAMPAIGN_FROM_DATE,
        "distributionLevelId": 1,
        "enabled": enabled,
        "stores": [],
    }


def build_campaign_summary(
    campaign: dict[str, Any] | None,
    *,
    status: str,
    would_create_on_apply: bool = False,
    would_enable_on_apply: bool = False,
) -> dict[str, Any]:
    return {
        "id": None if campaign is None else campaign.get("id"),
        "name": CAMPAIGN_NAME if campaign is None else campaign.get("name"),
        "description": CAMPAIGN_DESCRIPTION if campaign is None else campaign.get("description"),
        "enabled": False if campaign is None else bool(campaign.get("enabled")),
        "fromDate": CAMPAIGN_FROM_DATE if campaign is None else campaign.get("fromDate"),
        "status": status,
        "wouldCreateOnApply": would_create_on_apply,
        "wouldEnableOnApply": would_enable_on_apply,
    }


def ensure_campaign(helper: Any, auth: str, ctx: StoreContext, *, apply_changes: bool, delay_seconds: float) -> dict[str, Any]:
    campaign = find_site_campaign(helper, auth, ctx, CAMPAIGN_NAME)
    if campaign is None:
        if not apply_changes:
            return build_campaign_summary(None, status="missing", would_create_on_apply=True)
        helper.rpc(auth, "store.promo.campaign.add", campaign_payload(enabled=True), timeout=120)
        maybe_wait(delay_seconds)
        campaign = find_site_campaign(helper, auth, ctx, CAMPAIGN_NAME)
    if campaign is None:
        raise RuntimeError(f"Campaign {CAMPAIGN_NAME} was not readable in {ctx.dealer_name}")
    if not campaign.get("enabled"):
        if not apply_changes:
            return build_campaign_summary(campaign, status="disabled", would_enable_on_apply=True)
        payload = campaign_payload(enabled=True)
        payload["id"] = str(campaign["id"])
        helper.rpc(auth, "store.promo.campaign.edit", payload, timeout=120)
        maybe_wait(delay_seconds)
        campaign = find_site_campaign(helper, auth, ctx, CAMPAIGN_NAME)
    if campaign is None:
        raise RuntimeError(f"Campaign {CAMPAIGN_NAME} disappeared after enable")
    return build_campaign_summary(campaign, status="ready")


def list_actions(helper: Any, auth: str, campaign_id: str) -> list[dict[str, Any]]:
    result = helper.rpc(
        auth,
        "store.promo.action.list",
        {"campaignId": campaign_id, "page": 1, "pageSize": ACTION_LIST_PAGE_SIZE},
        timeout=120,
    )
    return result.get("data") or []


def encode_blob(payload: dict[str, Any]) -> str:
    return base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()


def selector_data_blob() -> str:
    return encode_blob(
        {
            "id": "__ROOT__",
            "root": True,
            "combinator": "and",
            "rules": [
                {
                    "id": str(uuid.uuid4()),
                    "new": True,
                    "field": "categoriesIds",
                    "type": "categoryMultiSelect",
                    "operator": "equal",
                    "value": CATEGORY_VALUES,
                }
            ],
            "touched": True,
        }
    )


def filter_data_blob() -> str:
    return encode_blob(
        {
            "id": "__ROOT__",
            "root": True,
            "combinator": "and",
            "rules": [
                {
                    "id": str(uuid.uuid4()),
                    "new": True,
                    "field": "shelf_time_in_days",
                    "type": "number",
                    "operator": "less",
                    "value": RECEPTION_MAX_DAYS,
                },
                {
                    "id": str(uuid.uuid4()),
                    "new": True,
                    "field": "thc",
                    "type": "number",
                    "operator": "greater",
                    "value": THC_MIN_PERCENT,
                },
            ],
            "touched": True,
        }
    )


def action_add_payload(campaign_id: str) -> dict[str, Any]:
    return {
        "campaignId": campaign_id,
        "applicationStepId": 3,
        "applicationTargetId": 1,
        "applicationModeId": 1,
        "applicationTypeId": 1,
        "actionTypeId": 4,
        "actionMixAndMatchTypeId": 1,
        "name": ACTION_NAME,
        "shortName": ACTION_SHORT_NAME,
        "description": ACTION_DESCRIPTION,
        "fromDate": ACTION_FROM_DATE,
        "cronExpression": "0 0 * * * *",
        "displayInEcommerceProducts": False,
        "ecommerceDiscountMenuActionDisplayTypeId": 3,
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


def selector_payload(action_id: str) -> dict[str, Any]:
    return {
        "actionId": action_id,
        "applicationModeId": 2,
        "distributionLevelId": 3,
        "stackTypeId": 1,
        "selectorData": selector_data_blob(),
        "filterData": filter_data_blob(),
        "categories": [{"id": item["id"], "name": item["name"]} for item in CATEGORY_VALUES],
        "enabled": True,
    }


def decoded_rule_summary(blob: str | None) -> list[tuple[str | None, str | None, Any]]:
    if not blob:
        return []
    payload = json.loads(base64.b64decode(blob).decode())
    return sorted((rule.get("field"), rule.get("operator"), rule.get("value")) for rule in payload.get("rules") or [])


def category_id_set(selector: dict[str, Any]) -> set[int]:
    return {int(item["id"]) for item in selector.get("categories") or [] if item.get("id") is not None}


def build_action_summary(
    detail: dict[str, Any] | None,
    *,
    status: str,
    would_create_on_apply: bool = False,
    would_enable_on_apply: bool = False,
    would_configure_selector_on_apply: bool = False,
    selector_product_count: int | None = None,
) -> dict[str, Any]:
    return {
        "id": None if detail is None else detail.get("id"),
        "name": ACTION_NAME if detail is None else detail.get("name"),
        "enabled": False if detail is None else bool(detail.get("enabled")),
        "status": status,
        "selectorProductCount": selector_product_count,
        "readyForReplacement": bool(selector_product_count and selector_product_count > 0),
        "wouldCreateOnApply": would_create_on_apply,
        "wouldEnableOnApply": would_enable_on_apply,
        "wouldConfigureSelectorOnApply": would_configure_selector_on_apply,
    }


def read_selector_product_count(detail: dict[str, Any]) -> int | None:
    selectors = detail.get("getSelectors") or []
    if len(selectors) != 1:
        return None
    return int(selectors[0].get("productCount") or 0)


def ensure_action(
    helper: Any,
    auth: str,
    campaign_id: str,
    *,
    apply_changes: bool,
    delay_seconds: float,
) -> dict[str, Any]:
    existing = None
    for row in list_actions(helper, auth, campaign_id):
        if row.get("name") == ACTION_NAME:
            existing = row
            break

    if existing is None:
        if not apply_changes:
            return build_action_summary(None, status="missing", would_create_on_apply=True)
        created = helper.rpc(auth, "store.promo.action.add", action_add_payload(campaign_id), timeout=120)
        action_id = str(created["id"])
        helper.rpc(auth, "store.promo.selector.get.add", selector_payload(action_id), timeout=120)
        helper.rpc(auth, "store.promo.action.edit", {"id": action_id, "enabled": True}, timeout=120)
        maybe_wait(delay_seconds)
        detail = helper.rpc(auth, "store.promo.action.get", {"id": action_id}, timeout=120)
        return build_action_summary(detail, status="created", selector_product_count=read_selector_product_count(detail))

    action_id = str(existing["id"])
    detail = helper.rpc(auth, "store.promo.action.get", {"id": action_id}, timeout=120)
    selectors = detail.get("getSelectors") or []
    if not selectors:
        if not apply_changes:
            return build_action_summary(
                detail,
                status="missing_selector",
                would_configure_selector_on_apply=True,
                selector_product_count=None,
            )
        helper.rpc(auth, "store.promo.selector.get.add", selector_payload(action_id), timeout=120)
        helper.rpc(auth, "store.promo.action.edit", {"id": action_id, "enabled": True}, timeout=120)
        maybe_wait(delay_seconds)
        detail = helper.rpc(auth, "store.promo.action.get", {"id": action_id}, timeout=120)
        return build_action_summary(detail, status="updated", selector_product_count=read_selector_product_count(detail))
    if len(selectors) != 1:
        raise RuntimeError(f"Existing Midtown {ACTION_NAME} action has {len(selectors)} get selectors; expected 1")
    selector = selectors[0]
    expected_categories = {int(item["id"]) for item in CATEGORY_VALUES}
    if category_id_set(selector) != expected_categories:
        raise RuntimeError(f"Existing Midtown {ACTION_NAME} selector categories did not match expected scope")
    expected_rules = sorted([
        ("shelf_time_in_days", "less", RECEPTION_MAX_DAYS),
        ("thc", "greater", THC_MIN_PERCENT),
    ])
    if decoded_rule_summary(selector.get("filterData")) != expected_rules:
        raise RuntimeError(f"Existing Midtown {ACTION_NAME} filter rules did not match expected rules")
    if not detail.get("enabled"):
        if not apply_changes:
            return build_action_summary(
                detail,
                status="disabled",
                would_enable_on_apply=True,
                selector_product_count=read_selector_product_count(detail),
            )
        helper.rpc(auth, "store.promo.action.edit", {"id": action_id, "enabled": True}, timeout=120)
        maybe_wait(delay_seconds)
        detail = helper.rpc(auth, "store.promo.action.get", {"id": action_id}, timeout=120)
    return build_action_summary(detail, status="ready", selector_product_count=read_selector_product_count(detail))


def selector_ids(value: Any) -> Any:
    if value in (None, [], {}):
        return None
    if isinstance(value, list) and all(isinstance(item, dict) and "id" in item for item in value):
        return [item["id"] for item in value]
    return value


def date_only(value: Any) -> Any:
    if isinstance(value, str) and "T" in value:
        return value.split("T", 1)[0]
    return value


def build_banner_edit_params(detail: dict[str, Any], enabled: bool) -> dict[str, Any]:
    type_id = detail["type"]["id"]
    params: dict[str, Any] = {
        "enabled": enabled,
        "brands": selector_ids(detail.get("brands")),
        "categories": selector_ids(detail.get("categories")),
        "products": selector_ids(detail.get("products")),
        "productGroups": selector_ids(detail.get("productGroups")),
        "qualityLines": selector_ids(detail.get("qualityLines")),
        "sizes": selector_ids(detail.get("sizes")),
        "subCategories": selector_ids(detail.get("subCategories")),
        "productTypes": selector_ids(detail.get("productTypes")),
        "maxWholesaleCost": detail.get("maxWholesaleCost"),
        "minWholesaleCost": detail.get("minWholesaleCost"),
        "promoActionId": detail.get("promoActionId"),
        "usePromoHeader": detail.get("usePromoHeader"),
        "fromDate": date_only(detail.get("fromDate")),
        "toDate": date_only(detail.get("toDate")),
        "typeId": type_id,
        "id": detail["id"],
    }
    if type_id == PRODUCT_MENU_TYPE_ID:
        params["layoutTypeId"] = CARD_LAYOUT_TYPE_ID
        params["productsDisplayed"] = STANDARD_PRODUCTS_DISPLAYED
    if detail.get("cronExpression") is not None:
        params["cronExpression"] = detail.get("cronExpression")
    if "fromTime" in detail:
        params["fromTime"] = detail.get("fromTime")
    if "toTime" in detail:
        params["toTime"] = detail.get("toTime")
    return params


def set_banner_enabled(helper: Any, auth: str, detail: dict[str, Any], enabled: bool, *, delay_seconds: float) -> dict[str, Any]:
    helper.rpc(auth, "store.screen.carousel.banner.edit", build_banner_edit_params(detail, enabled), timeout=120)
    maybe_wait(delay_seconds)
    return helper.rpc(auth, "store.screen.carousel.banner.get", {"id": str(detail["id"] )}, timeout=120)


def add_product_menu_banner(
    helper: Any,
    auth: str,
    *,
    screen_id: int,
    ordering: int,
    duration: int,
    promo_action_id: str,
    delay_seconds: float,
) -> dict[str, Any]:
    created = helper.rpc(
        auth,
        "store.screen.carousel.banner.add",
        {
            "screenId": screen_id,
            "name": FRESH_BANNER_NAME,
            "typeId": 3,
            "enabled": False,
            "ordering": ordering,
            "fromDate": today_string(),
            "duration": duration,
            "promoActionId": promo_action_id,
            "usePromoHeader": True,
            "layoutTypeId": 2,
            "cronExpression": "0 0 * * * *",
            "showNumberOfItemsInHeader": False,
        },
        timeout=120,
    )
    maybe_wait(delay_seconds)
    return helper.rpc(auth, "store.screen.carousel.banner.get", {"id": str(created["id"] )}, timeout=120)


def list_screens(helper: Any, auth: str) -> list[dict[str, Any]]:
    page = 1
    page_size = 200
    screens: list[dict[str, Any]] = []
    while True:
        result = helper.rpc(auth, "store.screen.carousel.list", {"page": page, "pageSize": page_size}, timeout=120)
        data = result.get("data") or []
        screens.extend(data)
        if len(screens) >= result.get("totalCount", 0) or not data:
            return screens
        page += 1


def load_fresh_targets(clone_results_path: Path) -> list[dict[str, Any]]:
    clone_results = json.loads(clone_results_path.read_text(encoding="utf-8"))
    targets: list[dict[str, Any]] = []
    for screen in clone_results.get("midtownCloneRun", {}).get("screens", []):
        for created in screen.get("created", []):
            if created.get("bannerName") != FRESH_BANNER_NAME:
                continue
            targets.append(
                {
                    "screenId": int(screen["screenId"]),
                    "screenName": screen["screenName"],
                    "imageBannerId": str(created["bannerId"]),
                    "ordering": int(created["ordering"]),
                    "duration": int(created["duration"]),
                }
            )
    return sorted(targets, key=lambda item: item["screenName"])


def read_banner_detail(helper: Any, auth: str, banner_id: str) -> dict[str, Any] | None:
    try:
        return helper.rpc(auth, "store.screen.carousel.banner.get", {"id": banner_id}, timeout=120)
    except RuntimeError as exc:
        message = str(exc)
        if "Action does not exist or you do not have permission" in message:
            return None
        raise


def replace_banners(
    helper: Any,
    auth: str,
    promo_action_id: str | None,
    *,
    apply_changes: bool,
    clone_results_path: Path,
    delay_seconds: float,
) -> list[dict[str, Any]]:
    screen_map = {int(screen["id"]): screen for screen in list_screens(helper, auth)}
    results: list[dict[str, Any]] = []
    for target in load_fresh_targets(clone_results_path):
        screen = screen_map.get(target["screenId"])
        if screen is None:
            raise RuntimeError(f"Midtown screen {target['screenId']} not found")
        print_progress(f"Replacing {FRESH_BANNER_NAME} on {target['screenName']} ({target['screenId']})")
        result = {
            "screenId": target["screenId"],
            "screenName": target["screenName"],
            "currentImageBanner": None,
            "screenToggle": {
                "originalEnabled": bool(screen.get("enabled")),
                "originalTotalScreenDuration": int(screen.get("totalScreenDuration") or 0),
            },
            "deletedImageBanner": None,
            "newProductMenuBanner": None,
            "plannedProductMenuBanner": {
                "bannerName": FRESH_BANNER_NAME,
                "duration": target["duration"],
                "ordering": target["ordering"],
                "promoActionId": promo_action_id,
            },
            "skippedTargetReason": None,
        }

        old_detail = read_banner_detail(helper, auth, target["imageBannerId"])
        if old_detail is None:
            result["skippedTargetReason"] = "image_banner_not_found"
            results.append(result)
            continue

        result["currentImageBanner"] = {
            "bannerId": str(old_detail["id"]),
            "bannerName": old_detail["name"],
            "enabled": bool(old_detail.get("enabled")),
            "ordering": int(old_detail["ordering"]),
            "duration": int(old_detail.get("duration") or target["duration"]),
            "totalDuration": int(old_detail.get("totalDuration") or 0),
            "type": (old_detail.get("type") or {}).get("name"),
        }
        result["plannedProductMenuBanner"]["ordering"] = int(old_detail["ordering"])
        result["plannedProductMenuBanner"]["duration"] = int(old_detail.get("duration") or target["duration"])

        if not apply_changes:
            results.append(result)
            continue

        if not promo_action_id:
            raise RuntimeError("A live Fresh & INTENSE replacement requires a resolved promo action id.")

        new_detail = add_product_menu_banner(
            helper,
            auth,
            screen_id=target["screenId"],
            ordering=int(result["plannedProductMenuBanner"]["ordering"]),
            duration=int(result["plannedProductMenuBanner"]["duration"]),
            promo_action_id=promo_action_id,
            delay_seconds=delay_seconds,
        )

        old_detail = set_banner_enabled(helper, auth, old_detail, False, delay_seconds=delay_seconds)
        screen_off = helper.rpc(auth, "store.screen.carousel.edit", {"id": target["screenId"], "enabled": False}, timeout=120)
        maybe_wait(delay_seconds)

        new_detail = set_banner_enabled(helper, auth, new_detail, True, delay_seconds=delay_seconds)
        result["newProductMenuBanner"] = {
            "bannerId": str(new_detail["id"]),
            "bannerName": new_detail["name"],
            "promoActionId": new_detail.get("promoActionId"),
            "afterEnableEnabled": bool(new_detail.get("enabled")),
            "afterEnableTotalDuration": int(new_detail.get("totalDuration") or 0),
        }
        result["screenToggle"]["afterScreenOffEnabled"] = bool(screen_off.get("enabled"))
        result["screenToggle"]["afterScreenOffTotalScreenDuration"] = int(screen_off.get("totalScreenDuration") or 0)

        if int(new_detail.get("totalDuration") or 0) <= 0:
            new_detail = set_banner_enabled(helper, auth, new_detail, False, delay_seconds=delay_seconds)
            old_detail = set_banner_enabled(helper, auth, old_detail, True, delay_seconds=delay_seconds)
            result["newProductMenuBanner"]["finalEnabled"] = bool(new_detail.get("enabled"))
            result["newProductMenuBanner"]["finalTotalDuration"] = int(new_detail.get("totalDuration") or 0)
            result["keptImageFallback"] = {
                "bannerId": str(old_detail["id"]),
                "bannerName": old_detail["name"],
                "finalEnabled": bool(old_detail.get("enabled")),
                "finalTotalDuration": int(old_detail.get("totalDuration") or 0),
            }
        else:
            helper.rpc(auth, "store.screen.carousel.banner.delete", {"id": str(old_detail["id"] )}, timeout=120)
            maybe_wait(delay_seconds)
            result["deletedImageBanner"] = {
                "bannerId": str(old_detail["id"]),
                "bannerName": old_detail["name"],
                "type": (old_detail.get("type") or {}).get("name"),
            }
            result["newProductMenuBanner"]["finalEnabled"] = bool(new_detail.get("enabled"))
            result["newProductMenuBanner"]["finalTotalDuration"] = int(new_detail.get("totalDuration") or 0)

        screen_on = helper.rpc(auth, "store.screen.carousel.edit", {"id": target["screenId"], "enabled": True}, timeout=120)
        maybe_wait(delay_seconds)
        result["screenToggle"]["finalEnabled"] = bool(screen_on.get("enabled"))
        result["screenToggle"]["finalTotalScreenDuration"] = int(screen_on.get("totalScreenDuration") or 0)
        results.append(result)
    return results


def main() -> int:
    args = parse_args()
    clone_results_path = latest_clone_results_path(args.clone_results_path)
    helper = load_helper()
    auth = load_auth_token(args, helper)
    initial = helper.rpc(auth, "store.auth.initial.data.get", timeout=120)
    initial_user = initial.get("user") or {}
    initial_dealer_id = initial_user.get("currentDealerId")
    initial_dealer_name = initial_user.get("currentDealerName")

    summary: dict[str, Any] = {
        "startedAt": iso_now(),
        "mode": "apply" if args.apply else "dry-run",
        "sourceCloneArtifactPath": str(clone_results_path),
        "initialDealer": {"dealerId": initial_dealer_id, "dealerName": initial_dealer_name},
    }

    try:
        switch_context(helper, auth, MIDTOWN_CONTEXT)
        campaign = ensure_campaign(
            helper,
            auth,
            MIDTOWN_CONTEXT,
            apply_changes=args.apply,
            delay_seconds=args.delay_seconds,
        )
        summary["campaign"] = campaign
        if campaign.get("id") is None:
            summary["action"] = build_action_summary(None, status="missing_campaign", would_create_on_apply=True)
            summary["screens"] = replace_banners(
                helper,
                auth,
                None,
                apply_changes=False,
                clone_results_path=clone_results_path,
                delay_seconds=args.delay_seconds,
            )
        else:
            action = ensure_action(
                helper,
                auth,
                str(campaign["id"]),
                apply_changes=args.apply,
                delay_seconds=args.delay_seconds,
            )
            summary["action"] = action
            if args.apply and not action.get("readyForReplacement"):
                raise RuntimeError(
                    f"Action {action.get('id') or ACTION_NAME} still has selector productCount "
                    f"{action.get('selectorProductCount')}; refusing to replace image banners"
                )
            summary["screens"] = replace_banners(
                helper,
                auth,
                None if action.get("id") is None else str(action["id"]),
                apply_changes=args.apply,
                clone_results_path=clone_results_path,
                delay_seconds=args.delay_seconds,
            )
    finally:
        if isinstance(initial_dealer_id, int):
            try:
                helper.rpc(auth, "store.auth.dealer.set", {"dealerId": initial_dealer_id}, timeout=120)
            except Exception:
                pass

    summary["finishedAt"] = iso_now()
    args.output.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    planned_count = sum(1 for screen in summary.get("screens", []) if screen.get("plannedProductMenuBanner"))
    created_count = sum(1 for screen in summary.get("screens", []) if screen.get("newProductMenuBanner"))
    print_progress(
        f"Completed {summary['mode']} Midtown Fresh & INTENSE promo rebinding across {len(summary.get('screens', []))} screen(s); "
        f"planned {planned_count} replacement(s), created {created_count} banner(s). Summary written to {args.output}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
