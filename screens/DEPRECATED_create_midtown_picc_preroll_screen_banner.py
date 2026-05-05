# DEPRECATED: This script directly mutates Sweed screen banners and is older than one week.
# All future screen-banner development and maintenance must be done in Helios under
# helios. Treat this file as historical reference only; do not
# extend it, do not run it for live banner work, and do not import from it.
# See HOW_HELIOS_WORKS.md and docs/sweed/marketing/screens-and-banners.md.

#!/usr/bin/env python3

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


HELPER_PATH = Path(
    "/Users/dave/tmp/scratch/fbnyc/sweed/automation/customers/segmentation/2026-04-11/import_sweed_customers_to_crm.py"
)
DEFAULT_OUTPUT_PATH = Path(__file__).resolve().parent / "midtown_picc_preroll_screen_banner_results.json"
DEFAULT_DELAY_SECONDS = 0.5
TARGET_ACTION_ID = "42837"
TARGET_DURATION_SECONDS = 10
TARGET_LAYOUT_TYPE_ID = 2
TARGET_PRODUCTS_DISPLAYED = 3
TARGET_SCREEN_IDS = [250, 251, 252, 276]


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create the direct Midtown PICC preroll promo-backed product-menu banner across the active Midtown screens."
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
        help="Perform the live banner creates. Without this flag the script only records the intended target state.",
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


def load_target_screen_map(helper: Any, auth: str) -> dict[int, dict[str, Any]]:
    last_screen_map: dict[int, dict[str, Any]] = {}
    for _ in range(5):
        screen_map = {int(screen["id"]): screen for screen in list_screens(helper, auth)}
        if all(screen_id in screen_map for screen_id in TARGET_SCREEN_IDS):
            return screen_map
        last_screen_map = screen_map
        time.sleep(1)
    missing = [screen_id for screen_id in TARGET_SCREEN_IDS if screen_id not in last_screen_map]
    raise RuntimeError(
        f"Midtown screen list was missing target screen(s) {missing}; visible screens were {sorted(last_screen_map)}"
    )


def list_screen_banners(helper: Any, auth: str, screen_id: int) -> list[dict[str, Any]]:
    return midtown_read_rpc(helper, auth, "store.screen.carousel.banner.list", {"screenId": screen_id}) or []


def read_banner_detail(helper: Any, auth: str, banner_id: str) -> dict[str, Any]:
    return midtown_read_rpc(helper, auth, "store.screen.carousel.banner.get", {"id": banner_id})


def read_action_detail(helper: Any, auth: str) -> dict[str, Any]:
    return midtown_read_rpc(helper, auth, "store.promo.action.get", {"id": TARGET_ACTION_ID})


def read_screen_promo_row(helper: Any, auth: str) -> dict[str, Any] | None:
    rows = midtown_read_rpc(helper, auth, "store.screen.carousel.banner.promo.list", {}) or []
    for row in rows:
        if str(row.get("id")) == TARGET_ACTION_ID:
            return row
    return None


def build_banner_summary(detail: dict[str, Any], *, status: str) -> dict[str, Any]:
    layout_type = detail.get("layoutType") or {}
    media = detail.get("media") or {}
    return {
        "id": str(detail.get("id")),
        "name": detail.get("name"),
        "screenId": int(detail.get("screenId") or 0),
        "ordering": int(detail.get("ordering") or 0),
        "enabled": bool(detail.get("enabled")),
        "duration": int(detail.get("duration") or 0),
        "totalDuration": int(detail.get("totalDuration") or 0),
        "promoActionId": str(detail.get("promoActionId") or ""),
        "usePromoHeader": bool(detail.get("usePromoHeader")),
        "layoutTypeId": layout_type.get("id"),
        "layoutTypeName": layout_type.get("name"),
        "productsDisplayed": detail.get("productsDisplayed"),
        "mediaId": media.get("id"),
        "mediaUrl": media.get("url"),
        "status": status,
    }


def add_banner(helper: Any, auth: str, *, screen_id: int, ordering: int, banner_name: str) -> dict[str, Any]:
    created = midtown_write_rpc(
        helper,
        auth,
        "store.screen.carousel.banner.add",
        {
            "screenId": screen_id,
            "name": banner_name,
            "typeId": 3,
            "enabled": False,
            "ordering": ordering,
            "fromDate": today_string(),
            "duration": TARGET_DURATION_SECONDS,
            "promoActionId": TARGET_ACTION_ID,
            "usePromoHeader": True,
            "layoutTypeId": TARGET_LAYOUT_TYPE_ID,
            "productsDisplayed": TARGET_PRODUCTS_DISPLAYED,
            "cronExpression": "0 0 * * * *",
            "showNumberOfItemsInHeader": False,
        },
    )
    return read_banner_detail(helper, auth, str(created["id"]))


def ensure_screen_banners(helper: Any, auth: str, *, banner_name: str, apply_changes: bool, delay_seconds: float) -> list[dict[str, Any]]:
    screen_map = load_target_screen_map(helper, auth)
    results: list[dict[str, Any]] = []
    for screen_id in TARGET_SCREEN_IDS:
        screen = screen_map.get(screen_id)
        if screen is None:
            raise RuntimeError(f"Midtown screen {screen_id} was not found")
        screen_banners = list_screen_banners(helper, auth, screen_id)
        matching = [row for row in screen_banners if str(row.get("promoActionId")) == TARGET_ACTION_ID]
        if len(matching) > 1:
            raise RuntimeError(f"Screen {screen_id} already has multiple banners for promo action {TARGET_ACTION_ID}")

        next_ordering = max((int(row.get("ordering") or 0) for row in screen_banners), default=0) + 1
        screen_result: dict[str, Any] = {
            "screenId": screen_id,
            "screenName": screen.get("name"),
            "plannedOrdering": next_ordering,
            "banner": None,
        }
        if matching:
            detail = read_banner_detail(helper, auth, str(matching[0]["id"]))
            screen_result["banner"] = build_banner_summary(detail, status="existing")
            results.append(screen_result)
            continue

        if not apply_changes:
            screen_result["banner"] = {
                "id": None,
                "name": banner_name,
                "screenId": screen_id,
                "ordering": next_ordering,
                "enabled": False,
                "duration": TARGET_DURATION_SECONDS,
                "totalDuration": None,
                "promoActionId": TARGET_ACTION_ID,
                "usePromoHeader": True,
                "layoutTypeId": TARGET_LAYOUT_TYPE_ID,
                "layoutTypeName": "Card",
                "productsDisplayed": TARGET_PRODUCTS_DISPLAYED,
                "mediaId": None,
                "mediaUrl": None,
                "status": "planned",
            }
            results.append(screen_result)
            continue

        detail = add_banner(helper, auth, screen_id=screen_id, ordering=next_ordering, banner_name=banner_name)
        maybe_wait(delay_seconds)
        screen_result["banner"] = build_banner_summary(detail, status="created")
        results.append(screen_result)
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
        action = read_action_detail(helper, auth)
        screen_promo_row = read_screen_promo_row(helper, auth)
        if screen_promo_row is None:
            raise RuntimeError(f"Promo action {TARGET_ACTION_ID} is not currently available through banner.promo.list")

        summary["action"] = {
            "id": str(action.get("id")),
            "name": action.get("name"),
            "shortName": action.get("shortName"),
            "enabled": bool(action.get("enabled")),
            "campaignId": str(action.get("campaignId") or ""),
            "campaignName": action.get("campaignName") or (action.get("campaign") or {}).get("name"),
            "fromDate": action.get("fromDate"),
            "toDate": action.get("toDate"),
        }
        summary["screenPromoRow"] = screen_promo_row
        summary["screens"] = ensure_screen_banners(
            helper,
            auth,
            banner_name=action.get("name") or "PICC Preroll Promo",
            apply_changes=args.apply,
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
    print_progress(
        f"Completed {summary['mode']} Midtown PICC banner setup across {len(summary.get('screens', []))} screen(s). "
        f"Summary written to {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
