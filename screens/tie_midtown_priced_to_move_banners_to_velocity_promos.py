#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import socket
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


API_URL = "https://prime.sweedpos.com/api/"
MIDTOWN_DEALER_ID = 210705
TARGET_PROMOS = {
    "Priced to MOVE 5": {"actionId": "42260", "actionName": "Movers 5% off"},
    "Priced to MOVE 10": {"actionId": "42261", "actionName": "Movers 10% off"},
    "Priced to MOVE 15": {"actionId": "42262", "actionName": "Movers 15% off"},
}
DEFAULT_DELAY_SECONDS = 0.5
DEFAULT_OUTPUT_PATH = Path(__file__).resolve().parent / "tie_midtown_priced_to_move_banners_to_velocity_promos_results.json"
STATIC_CLONE_RESULTS_PATH = Path(__file__).resolve().parent / "clone_bronx_banners_to_midtown_results.json"
RUNTIME_CLONE_RESULTS_DIRECTORY = Path(__file__).resolve().parents[1] / "helios/runtime-artifacts/screens"
PRODUCT_MENU_TYPE_ID = 3
CARD_LAYOUT_TYPE_ID = 2
STANDARD_PRODUCTS_DISPLAYED = 3

ORIGINAL_GETADDRINFO = socket.getaddrinfo


def ipv4_first_getaddrinfo(host: str, port: int, family: int = 0, type: int = 0, proto: int = 0, flags: int = 0):
    if host == "prime.sweedpos.com":
        family = socket.AF_INET
    return ORIGINAL_GETADDRINFO(host, port, family, type, proto, flags)


socket.getaddrinfo = ipv4_first_getaddrinfo


class SweedClient:
    def __init__(self, auth_token: str, delay_seconds: float = DEFAULT_DELAY_SECONDS):
        self.auth_token = auth_token
        self.delay_seconds = delay_seconds

    def api_call(self, name: str, params: dict[str, Any] | None = None) -> Any:
        payload: dict[str, Any] = {
            "auth": self.auth_token,
            "name": name,
            "id": str(uuid.uuid4()),
        }
        if params is not None:
            payload["params"] = params

        request = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
            },
        )

        last_error: Exception | None = None
        for attempt in range(1, 4):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    raw = response.read().decode("utf-8")
                parsed = json.loads(raw)
                if "error" in parsed:
                    raise RuntimeError(f"Sweed RPC {name} failed: {parsed['error']}")
                return parsed.get("result")
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
                last_error = exc
                if attempt == 3:
                    break
                time.sleep(attempt)

        raise RuntimeError(f"Sweed RPC {name} failed after retries: {last_error}") from last_error

    def maybe_wait(self) -> None:
        if self.delay_seconds > 0:
            time.sleep(self.delay_seconds)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Replace Midtown Priced to MOVE image fallback banners with the documented Velocity Boosters promo-backed "
            "product-menu banners. Without --apply the script only records the current target state and the replacement plan."
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


def latest_har_path(explicit_path: Path | None) -> Path:
    if explicit_path is not None:
        return explicit_path

    har_paths = sorted(
        Path(__file__).resolve().parent.glob("prime.sweedpos.com*_Archive*.har"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not har_paths:
        raise SystemExit("No local HAR file found for auth-token extraction.")
    return har_paths[0]


def load_auth_token(args: argparse.Namespace) -> str:
    env_token = os.environ.get("SWEED_AUTH_TOKEN")
    if env_token:
        return env_token

    if args.auth_token:
        return args.auth_token

    har_path = latest_har_path(args.har_path)
    har = json.loads(har_path.read_text(encoding="utf-8"))
    for entry in har.get("log", {}).get("entries", []):
        text = entry.get("request", {}).get("postData", {}).get("text", "")
        if '"auth":"' not in text:
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        if payload.get("auth") and str(payload.get("name", "")).startswith("store.screen.carousel"):
            return payload["auth"]
    raise SystemExit(f"Could not extract auth token from {har_path}")


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


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def today_string() -> str:
    return date.today().isoformat()


def date_only(value: Any) -> Any:
    if isinstance(value, str) and "T" in value:
        return value.split("T", 1)[0]
    return value


def selector_ids(value: Any) -> Any:
    if value in (None, [], {}):
        return None
    if isinstance(value, list) and all(isinstance(item, dict) and "id" in item for item in value):
        return [item["id"] for item in value]
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


def set_banner_enabled(client: SweedClient, detail: dict[str, Any], enabled: bool) -> dict[str, Any]:
    client.api_call("store.screen.carousel.banner.edit", build_banner_edit_params(detail, enabled))
    client.maybe_wait()
    return client.api_call("store.screen.carousel.banner.get", {"id": detail["id"]})


def list_screens(client: SweedClient) -> list[dict[str, Any]]:
    page = 1
    page_size = 200
    screens: list[dict[str, Any]] = []
    while True:
        result = client.api_call("store.screen.carousel.list", {"page": page, "pageSize": page_size})
        batch = result.get("data", [])
        screens.extend(batch)
        if len(screens) >= result.get("totalCount", 0) or not batch:
            return screens
        page += 1


def add_product_menu_banner(
    client: SweedClient,
    *,
    screen_id: int,
    name: str,
    ordering: int,
    duration: int,
    promo_action_id: str,
) -> dict[str, Any]:
    return client.api_call(
        "store.screen.carousel.banner.add",
        {
            "screenId": screen_id,
            "name": name,
            "typeId": 3,
            "enabled": False,
            "ordering": ordering,
            "fromDate": today_string(),
            "duration": duration,
            "promoActionId": promo_action_id,
            "usePromoHeader": False,
            "layoutTypeId": 2,
            "cronExpression": "0 0 * * * *",
            "showCategoryInHeader": True,
            "showNumberOfItemsInHeader": True,
        },
    )


def print_progress(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def load_midtown_clone_targets(clone_results_path: Path) -> list[dict[str, Any]]:
    clone_results = json.loads(clone_results_path.read_text(encoding="utf-8"))
    screens: list[dict[str, Any]] = []
    for screen in clone_results.get("midtownCloneRun", {}).get("screens", []):
        target_banners: list[dict[str, Any]] = []
        for created in screen.get("created", []):
            if created.get("bannerName") not in TARGET_PROMOS:
                continue
            target_banners.append(
                {
                    "imageBannerId": str(created["bannerId"]),
                    "bannerName": created["bannerName"],
                    "ordering": int(created["ordering"]),
                    "duration": int(created["duration"]),
                    "promoActionId": TARGET_PROMOS[created["bannerName"]]["actionId"],
                    "promoActionName": TARGET_PROMOS[created["bannerName"]]["actionName"],
                }
            )
        if target_banners:
            screens.append(
                {
                    "screenId": int(screen["screenId"]),
                    "screenName": screen["screenName"],
                    "targets": sorted(target_banners, key=lambda item: item["ordering"]),
                }
            )
    return sorted(screens, key=lambda screen: screen["screenName"])


def read_banner_detail(client: SweedClient, banner_id: str) -> dict[str, Any] | None:
    try:
        return client.api_call("store.screen.carousel.banner.get", {"id": banner_id})
    except RuntimeError as exc:
        message = str(exc)
        if "Action does not exist or you do not have permission" in message:
            return None
        raise


def prepare_velocity_promos(client: SweedClient, *, apply_changes: bool) -> list[dict[str, Any]]:
    promo_actions: list[dict[str, Any]] = []
    for banner_name, promo in TARGET_PROMOS.items():
        detail = client.api_call("store.promo.action.get", {"id": promo["actionId"]})
        if detail.get("name") != promo["actionName"]:
            raise RuntimeError(
                f"Promo action {promo['actionId']} resolved to {detail.get('name')} instead of {promo['actionName']}"
            )
        enabled_at_start = bool(detail.get("enabled"))
        if apply_changes and not enabled_at_start:
            client.api_call("store.promo.action.edit", {"id": promo["actionId"], "enabled": True})
            client.maybe_wait()
            detail = client.api_call("store.promo.action.get", {"id": promo["actionId"]})
        promo_actions.append(
            {
                "bannerName": banner_name,
                "actionId": str(detail["id"]),
                "actionName": detail["name"],
                "enabledAtStart": enabled_at_start,
                "finalEnabled": bool(detail.get("enabled")),
                "discountPercent": detail.get("discountPercent"),
                "wouldEnableOnApply": (not enabled_at_start) if not apply_changes else False,
            }
        )
    return promo_actions


def main() -> None:
    args = parse_args()
    clone_results_path = latest_clone_results_path(args.clone_results_path)
    client = SweedClient(load_auth_token(args), delay_seconds=args.delay_seconds)
    initial = client.api_call("store.auth.initial.data.get")
    initial_user = initial.get("user", {})
    initial_dealer_id = initial_user.get("currentDealerId")
    initial_dealer_name = initial_user.get("currentDealerName")

    clone_targets = load_midtown_clone_targets(clone_results_path)
    results: dict[str, Any] = {
        "startedAt": iso_now(),
        "finishedAt": None,
        "mode": "apply" if args.apply else "dry-run",
        "sourceCloneArtifactPath": str(clone_results_path),
        "initialDealer": {"dealerId": initial_dealer_id, "dealerName": initial_dealer_name},
        "promoActions": [],
        "screens": [],
    }

    try:
        client.api_call("store.auth.dealer.set", {"dealerId": MIDTOWN_DEALER_ID})
        results["promoActions"] = prepare_velocity_promos(client, apply_changes=args.apply)
        screens_by_id = {int(screen["id"]): screen for screen in list_screens(client)}

        for screen_target in clone_targets:
            screen_id = screen_target["screenId"]
            live_screen = screens_by_id.get(screen_id)
            if live_screen is None:
                raise RuntimeError(f"Midtown screen {screen_id} was not found")

            print_progress(f"Replacing Priced to MOVE banners on {screen_target['screenName']} ({screen_id})")
            screen_result: dict[str, Any] = {
                "screenId": screen_id,
                "screenName": screen_target["screenName"],
                "currentImageBanners": [],
                "plannedProductMenuBanners": [],
                "skippedTargets": [],
                "screenToggle": {
                    "originalEnabled": bool(live_screen.get("enabled")),
                    "originalTotalScreenDuration": int(live_screen.get("totalScreenDuration") or 0),
                },
                "deletedImageBanners": [],
                "createdProductMenuBanners": [],
            }

            image_details_by_name: dict[str, dict[str, Any]] = {}
            for target in screen_target["targets"]:
                image_detail = read_banner_detail(client, target["imageBannerId"])
                if image_detail is None:
                    screen_result["skippedTargets"].append(
                        {
                            "bannerName": target["bannerName"],
                            "imageBannerId": target["imageBannerId"],
                            "promoActionId": target["promoActionId"],
                            "promoActionName": target["promoActionName"],
                            "reason": "image_banner_not_found",
                        }
                    )
                    continue

                image_details_by_name[target["bannerName"]] = image_detail
                screen_result["currentImageBanners"].append(
                    {
                        "bannerId": str(image_detail["id"]),
                        "bannerName": image_detail["name"],
                        "enabled": bool(image_detail.get("enabled")),
                        "ordering": int(image_detail["ordering"]),
                        "duration": int(image_detail.get("duration") or target["duration"]),
                        "totalDuration": int(image_detail.get("totalDuration") or 0),
                        "type": (image_detail.get("type") or {}).get("name"),
                    }
                )
                screen_result["plannedProductMenuBanners"].append(
                    {
                        "bannerName": target["bannerName"],
                        "duration": int(image_detail.get("duration") or target["duration"]),
                        "ordering": int(image_detail["ordering"]),
                        "promoActionId": target["promoActionId"],
                        "promoActionName": target["promoActionName"],
                    }
                )

            if not args.apply or not screen_result["plannedProductMenuBanners"]:
                results["screens"].append(screen_result)
                continue

            created_details: list[dict[str, Any]] = []
            for target in screen_result["plannedProductMenuBanners"]:
                created = add_product_menu_banner(
                    client,
                    screen_id=screen_id,
                    name=target["bannerName"],
                    ordering=int(target["ordering"]),
                    duration=int(target["duration"]),
                    promo_action_id=target["promoActionId"],
                )
                created_detail = client.api_call("store.screen.carousel.banner.get", {"id": str(created["id"])} )
                created_details.append(created_detail)
                screen_result["createdProductMenuBanners"].append(
                    {
                        "bannerId": str(created_detail["id"]),
                        "bannerName": created_detail["name"],
                        "ordering": int(created_detail["ordering"]),
                        "duration": int(created_detail.get("duration") or 0),
                        "promoActionId": created_detail.get("promoActionId"),
                        "promoActionName": (created_detail.get("promoAction") or {}).get("name"),
                        "createdEnabled": bool(created_detail.get("enabled")),
                        "createdTotalDuration": int(created_detail.get("totalDuration") or 0),
                    }
                )

            image_details = list(image_details_by_name.values())
            for image_detail in image_details:
                if image_detail.get("enabled"):
                    image_detail = set_banner_enabled(client, image_detail, False)
                screen_result["deletedImageBanners"].append(
                    {
                        "bannerId": str(image_detail["id"]),
                        "bannerName": image_detail["name"],
                        "enabledBeforeDelete": bool(image_detail.get("enabled")),
                        "type": (image_detail.get("type") or {}).get("name"),
                    }
                )

            screen_off = client.api_call("store.screen.carousel.edit", {"id": screen_id, "enabled": False})
            client.maybe_wait()
            screen_result["screenToggle"]["afterScreenOffEnabled"] = bool(screen_off.get("enabled"))
            screen_result["screenToggle"]["afterScreenOffTotalScreenDuration"] = int(screen_off.get("totalScreenDuration") or 0)

            for image_detail in image_details:
                client.api_call("store.screen.carousel.banner.delete", {"id": str(image_detail["id"])} )
                client.maybe_wait()

            for created_result, created_detail in zip(screen_result["createdProductMenuBanners"], created_details, strict=True):
                created_detail = set_banner_enabled(client, created_detail, True)
                created_result["afterEnableEnabled"] = bool(created_detail.get("enabled"))
                created_result["afterEnableTotalDuration"] = int(created_detail.get("totalDuration") or 0)
                if int(created_detail.get("totalDuration") or 0) == 0:
                    created_detail = set_banner_enabled(client, created_detail, False)
                created_result["finalEnabled"] = bool(created_detail.get("enabled"))
                created_result["finalTotalDuration"] = int(created_detail.get("totalDuration") or 0)
                print_progress(
                    f"Banner {created_result['bannerName']} ({created_result['bannerId']}) -> "
                    f"promo {created_result['promoActionName']} ({created_result['promoActionId']}), "
                    f"final enabled {created_result['finalEnabled']}, duration {created_result['finalTotalDuration']}s"
                )

            screen_on = client.api_call("store.screen.carousel.edit", {"id": screen_id, "enabled": True})
            client.maybe_wait()
            screen_result["screenToggle"]["finalEnabled"] = bool(screen_on.get("enabled"))
            screen_result["screenToggle"]["finalTotalScreenDuration"] = int(screen_on.get("totalScreenDuration") or 0)
            results["screens"].append(screen_result)

    finally:
        if isinstance(initial_dealer_id, int):
            try:
                client.api_call("store.auth.dealer.set", {"dealerId": initial_dealer_id})
            except RuntimeError:
                pass

    results["finishedAt"] = iso_now()
    args.output.write_text(json.dumps(results, indent=2), encoding="utf-8")
    replacement_count = sum(len(screen["plannedProductMenuBanners"]) for screen in results["screens"])
    created_count = sum(len(screen["createdProductMenuBanners"]) for screen in results["screens"])
    print_progress(
        f"Completed {results['mode']} Midtown Priced to MOVE promo rebinding across {len(results['screens'])} screen(s); "
        f"planned {replacement_count} replacement(s), created {created_count} banner(s). Summary written to {args.output}"
    )


if __name__ == "__main__":
    main()
