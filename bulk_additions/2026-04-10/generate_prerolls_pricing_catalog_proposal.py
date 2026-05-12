#!/usr/bin/env python3

from __future__ import annotations

import argparse
import copy
import csv
import concurrent.futures
import datetime as dt
import functools
import html
import json
import math
import re
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

import generate_product_catalog_attribute_analysis as analysis


WORKDIR = Path(__file__).resolve().parent
SOURCE_HAR_PATH = WORKDIR / "prime.sweedpos.com_api__Archive [26-04-12 18-00-33].har"
COMPETITOR_PROVIDER_HAR_PATH = WORKDIR / "brands.litalerts.com_Products_menulistings_Archive [26-04-12 15-28-15].har"
COMPETITOR_PROVIDER_STATEWIDE_EXACT_HAR_PATH = WORKDIR / "brands.litalerts.com_Products_menulistings_Archive [26-04-13 18-29-14].har"
COMPETITOR_RADIUS_PROVIDER_HAR_PATH = WORKDIR / "brands.litalerts.com_Dispensaries_alllocations_Archive [26-04-12 14-47-04].har"
COMPETITOR_AUTH_ARCHIVE_PATH = WORKDIR / "brands.litalerts.com_Archive [26-04-12 15-49-05].har"
OUTPUT_JSON_PATH = WORKDIR / "prerolls_pricing_catalog_proposal.json"
OUTPUT_CSV_PATH = WORKDIR / "prerolls_pricing_catalog_proposal.csv"
OUTPUT_HTML_PATH = WORKDIR / "prerolls_pricing_catalog_proposal.html"
OUTPUT_DETAIL_DIR = WORKDIR / "prerolls_pricing_catalog_proposal_details"

STATE_DEALER_ID = 210248
STATE_DEALER_NAME = "Freshly Baked NY"
TARGET_CATEGORY_ID = 1085
TARGET_CATEGORY_NAME = "Pre-Rolls"
PACKET_TITLE = "All Prerolls Pricing and Catalog Proposal"
KNOWN_PREROLL_SUBCATEGORIES = {
    "Single",
    "Multi-Pack",
    "Infused Pre-Roll",
    "Infused Pre-Roll Multi-Pack",
}
TARGET_MIN_GM_PERCENT = 55.0
TARGET_MAX_GM_PERCENT = 65.0
ABSOLUTE_MIN_GM_PERCENT = 30.0
POST_TAX_MULTIPLIER = 1.13
COMPETITOR_PRICE_DISCOUNT_FACTOR = 0.97
COMPETITOR_PROVIDER_PAGE_SIZE = 1_000
COMPETITOR_PROVIDER_EXACT_MATCH_MIN_SOURCES = 2
COMPETITOR_PROVIDER_BRAND_FAMILY_MIN_SOURCES = 3
COMPETITOR_PROVIDER_RADIUS_STEPS = (0.5, 1.0, 2.0, 3.5, 5.0, 10.0)
COMPETITOR_PROVIDER_MIN_RETAILERS = 4
COMPETITOR_PROVIDER_TARGET_MATCHES = 8
COMPETITOR_PROVIDER_MAX_WORKERS = 8
LITALERTS_STATE_ID = 265
LITALERTS_PREROLLS_CATEGORY_ID = "2"
LITALERTS_COGNITO_CLIENT_ID = "696jmvfc56kqe1bb38j55er8in"
LITALERTS_REFRESH_TOKEN_MARKER = "refreshToken="
STATIC_COMPETITOR_PROVIDER_SEARCH_TERMS = ("preroll", "pre-roll", "joint", "infused", "blunt")
EXCLUDED_COMPETITOR_RETAILER_NAME_CUES = ("freshly baked",)
REFERENCE_ADDRESS_LABEL = "40 W 55th St"
REFERENCE_ADDRESS_CITY = "New York, NY 10019"
REFERENCE_ADDRESS_LATITUDE = 40.762318
REFERENCE_ADDRESS_LONGITUDE = -73.97676
PRICE_HOLD_BRAND_KEYS = {"dank", "moonys"}
MFNY_SINGLE_075G_OVERRIDE_PRICE = 22.0
SUBSET_REQUEST_PARAMS = {
    "sortingColumns": [{"order": 10, "column": "price", "direction": "ascending"}],
    "distributorProductPrice": {"from": 1},
    "page": 1,
    "pageSize": 1_000,
    "reload": False,
    "advancedSearch": True,
    "categoryIds": [TARGET_CATEGORY_ID],
}
COMPETITOR_MATCH_STOPWORDS = {
    "pre",
    "roll",
    "rolls",
    "preroll",
    "prerolls",
    "joint",
    "joints",
    "single",
    "mini",
    "pack",
    "packs",
    "pk",
    "count",
    "ct",
    "infused",
    "blunt",
    "blunts",
    "wood",
    "tip",
    "tips",
    "live",
    "resin",
    "rosin",
    "hash",
    "diamond",
    "diamonds",
    "kief",
    "coated",
    "gram",
    "grams",
    "mg",
    "gram",
    "grams",
    "g",
    "the",
}
INFUSED_TEXT_CUES = (
    "infused",
    "moon rock",
    "moonrock",
    "kief",
    "diamond",
    "diamonds",
    "hash",
    "rosin",
    "resin",
    "bubble",
    "coated",
    "iced",
    "ice pack",
    "twisted fatty",
)
BLUNT_TEXT_CUES = ("blunt", "palm queen")
WEIGHT_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*(mg|g)\b", re.IGNORECASE)
PACK_AND_UNIT_PATTERNS = (
    re.compile(r"\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(mg|g)\b", re.IGNORECASE),
    re.compile(r"\b(\d+)\s*(?:pk|pack|ct|count)\s*[x-]?\s*(\d+(?:\.\d+)?)\s*(mg|g)\b", re.IGNORECASE),
    re.compile(r"\b(\d+)\s*(?:pk|pack|ct|count)\b.*?\b(\d+(?:\.\d+)?)\s*(mg|g)\b", re.IGNORECASE),
)
PACK_COUNT_PATTERNS = (
    re.compile(r"\b(\d+)\s*x\b", re.IGNORECASE),
    re.compile(r"\b(\d+)\s*(?:pk|pack|ct|count)\b", re.IGNORECASE),
)

INFERENCE_BY_LOWER = {name.lower(): payload for name, payload in analysis.INFERENCE.items()}
VERIFIED_BY_LOWER = {name.lower(): payload for name, payload in analysis.VERIFIED_STRAIN_LEAFLY.items()}


def grams_from_value(value: float | None) -> str:
    if value is None:
        return ""
    if abs(value - round(value)) < 1e-9:
        return f"{int(round(value))}g"
    return f"{value:.2f}".rstrip("0").rstrip(".") + "g"


def progress(message: str) -> None:
    timestamp = dt.datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def parse_weight_to_grams(text: str | None) -> float | None:
    if not text:
        return None
    match = WEIGHT_PATTERN.search(text)
    if not match:
        return None
    value = float(match.group(1))
    if match.group(2).lower() == "mg":
        value /= 1_000
    return round(value, 3)


def detect_infused(text: str) -> bool:
    lowered = text.lower()
    return any(cue in lowered for cue in INFUSED_TEXT_CUES)


def detect_blunt(text: str) -> bool:
    lowered = text.lower()
    return any(cue in lowered for cue in BLUNT_TEXT_CUES)


def parse_pack_count_and_unit_grams(text: str) -> tuple[int | None, float | None]:
    for pattern in PACK_AND_UNIT_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        pack_count = int(match.group(1))
        unit_value = float(match.group(2))
        if match.group(3).lower() == "mg":
            unit_value /= 1_000
        return pack_count, round(unit_value, 3)
    return None, None


def parse_pack_count(text: str) -> int:
    for pattern in PACK_COUNT_PATTERNS:
        match = pattern.search(text)
        if match:
            return int(match.group(1))
    return 1


def infer_format_profile(
    subcategory_name: str | None,
    product_name: str,
    group_name: str,
    size_name: str | None,
    total_weight_label: str | None = None,
) -> dict:
    normalized_subcategory = (subcategory_name or "").strip()
    text = f"{product_name} {group_name}".strip()
    explicit_pack_count, explicit_unit_grams = parse_pack_count_and_unit_grams(text)
    pack_count = explicit_pack_count or parse_pack_count(text)
    size_grams = parse_weight_to_grams(size_name)
    total_grams = parse_weight_to_grams(total_weight_label)

    if explicit_unit_grams is not None:
        per_unit_grams = explicit_unit_grams
        total_grams = total_grams or round(pack_count * per_unit_grams, 3)
    elif pack_count > 1 and size_grams is not None:
        per_unit_grams = size_grams
        total_grams = total_grams or round(pack_count * per_unit_grams, 3)
    elif pack_count > 1 and total_grams is not None:
        per_unit_grams = round(total_grams / pack_count, 3)
    else:
        per_unit_grams = size_grams or total_grams
        total_grams = total_grams or size_grams

    infused = normalized_subcategory in {"Infused", "Infused Pre-Roll", "Infused Pre-Roll Multi-Pack"} or detect_infused(text)
    blunt = detect_blunt(text)

    if normalized_subcategory in KNOWN_PREROLL_SUBCATEGORIES:
        base_lane = normalized_subcategory
        subcategory_source = "live-subcategory"
    elif normalized_subcategory == "Infused":
        base_lane = "Infused Pre-Roll Multi-Pack" if pack_count > 1 else "Infused Pre-Roll"
        subcategory_source = "live-subcategory"
    elif pack_count > 1 and infused:
        base_lane = "Infused Pre-Roll Multi-Pack"
        subcategory_source = "inferred-subcategory"
    elif pack_count > 1:
        base_lane = "Multi-Pack"
        subcategory_source = "inferred-subcategory"
    elif infused:
        base_lane = "Infused Pre-Roll"
        subcategory_source = "inferred-subcategory"
    else:
        base_lane = "Single"
        subcategory_source = "inferred-subcategory"

    display_subcategory = f"{base_lane} - Blunt" if blunt else base_lane
    size_label = (size_name or grams_from_value(per_unit_grams) or "unknown size").strip()
    variant_label = f"{pack_count}x {size_label}" if pack_count > 1 else size_label

    return {
        "baseLane": base_lane,
        "displaySubcategory": display_subcategory,
        "subcategorySource": subcategory_source,
        "packCount": pack_count,
        "perUnitGrams": per_unit_grams,
        "totalGrams": total_grams,
        "isInfused": infused,
        "isBlunt": blunt,
        "variantLabel": variant_label,
        "formatLaneKey": f"{base_lane}|{'blunt' if blunt else 'standard'}",
    }


def row_format_profile(row: dict) -> dict:
    return infer_format_profile(
        ((row.get("subcategory") or {}).get("name") or None),
        row.get("name") or "",
        ((row.get("productGroup") or {}).get("name") or ""),
        ((row.get("size") or {}).get("name") or None),
        ((row.get("size") or {}).get("name") or None),
    )


def source_format_profile(item_name: str, config_weight: str | None) -> dict:
    return infer_format_profile(
        None,
        item_name,
        "",
        config_weight,
        config_weight,
    )


def pricing_family_key(row: dict) -> tuple[str, str, float]:
    profile = row_format_profile(row)
    return (
        row["brand"]["name"],
        profile["displaySubcategory"],
        profile["variantLabel"],
        round(float(row["distributorProductPrice"]), 2),
    )


def normalize_match_text(text: str | None) -> str:
    lowered = (text or "").lower().replace("&", " and ")
    lowered = re.sub(r"\b\d+\s*x\s*\d+(?:\.\d+)?\s*(?:mg|g)\b", " ", lowered)
    lowered = re.sub(r"\b\d+\s*(?:pk|pack|ct|count)\b", " ", lowered)
    lowered = re.sub(r"\b\d+(?:\.\d+)?\s*(?:mg|g)\b", " ", lowered)
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered)
    return " ".join(part for part in lowered.split() if part not in COMPETITOR_MATCH_STOPWORDS)


def compact_match_text(text: str) -> str:
    return text.replace(" ", "")


def normalize_cultivar_name(product_name: str, brand_name: str, size_name: str | None = None) -> str:
    trimmed = product_name or ""
    if brand_name and trimmed.lower().startswith(brand_name.lower()):
        trimmed = trimmed[len(brand_name) :]
    if size_name:
        trimmed = trimmed.replace(size_name, "")
    return normalize_match_text(trimmed)


def normalized_brand_context(brand_name: str | None, item_name: str | None) -> str:
    return normalize_match_text(f"{brand_name or ''} {item_name or ''}")


def build_competitor_search_terms(source_rows: list[dict]) -> tuple[str, ...]:
    dynamic_terms: set[str] = set(STATIC_COMPETITOR_PROVIDER_SEARCH_TERMS)
    for row in source_rows:
        profile = row_format_profile(row)
        size_name = ((row.get("size") or {}).get("name") or "").strip().lower()
        if size_name:
            dynamic_terms.add(size_name)
        if profile["packCount"] > 1:
            dynamic_terms.add(profile["variantLabel"].lower())
    return tuple(term for term in STATIC_COMPETITOR_PROVIDER_SEARCH_TERMS if term in dynamic_terms) + tuple(
        sorted(term for term in dynamic_terms if term not in STATIC_COMPETITOR_PROVIDER_SEARCH_TERMS)
    )


def source_matches_brand(target_brand: str, source: dict) -> bool:
    target_brand_key = normalized_brand_key(target_brand)
    if not target_brand_key:
        return False
    source_brand_key = source.get("normalizedBrandName") or ""
    if source_brand_key:
        return target_brand_key in source_brand_key or source_brand_key in target_brand_key

    source_brand_compact = compact_match_text(source.get("normalizedBrandContext") or "")
    if not source_brand_compact:
        return False
    return target_brand_key in source_brand_compact or source_brand_compact in target_brand_key


def is_exactish_provider_match(target_cultivar: str, provider_cultivar: str) -> bool:
    if not target_cultivar or not provider_cultivar:
        return False

    target_compact = compact_match_text(target_cultivar)
    provider_compact = compact_match_text(provider_cultivar)
    if target_compact in provider_compact or provider_compact in target_compact:
        return True

    target_tokens = set(target_cultivar.split())
    provider_tokens = set(provider_cultivar.split())
    common_tokens = target_tokens & provider_tokens
    if len(common_tokens) >= 2:
        return True

    return len(target_tokens) == 1 and len(provider_tokens) == 1 and target_cultivar == provider_cultivar


def pack_structure_matches(target_profile: dict, source: dict) -> bool:
    if int(source.get("packCount") or 1) != int(target_profile["packCount"]):
        return False
    target_total = target_profile.get("totalGrams")
    source_total = source.get("totalGrams")
    if target_total is not None and source_total is not None and abs(float(target_total) - float(source_total)) > 0.16:
        return False
    target_per_unit = target_profile.get("perUnitGrams")
    source_per_unit = source.get("perUnitGrams")
    if (
        target_per_unit is not None
        and source_per_unit is not None
        and abs(float(target_per_unit) - float(source_per_unit)) > 0.06
    ):
        return False
    return True


def total_grams_match(target_profile: dict, source: dict) -> bool:
    target_total = target_profile.get("totalGrams")
    source_total = source.get("totalGrams")
    if target_total is None or source_total is None:
        return False
    return abs(float(target_total) - float(source_total)) <= 0.16


def same_lane_key(target_profile: dict, source: dict) -> bool:
    return source.get("formatLaneKey") == target_profile["formatLaneKey"]


def same_base_lane(target_profile: dict, source: dict) -> bool:
    return source.get("baseLane") == target_profile["baseLane"]


def haversine_miles(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    lat_a_rad = math.radians(lat_a)
    lon_a_rad = math.radians(lon_a)
    lat_b_rad = math.radians(lat_b)
    lon_b_rad = math.radians(lon_b)
    delta_lat = lat_b_rad - lat_a_rad
    delta_lon = lon_b_rad - lon_a_rad
    arc = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat_a_rad) * math.cos(lat_b_rad) * math.sin(delta_lon / 2) ** 2
    )
    return 3958.7613 * 2 * math.atan2(math.sqrt(arc), math.sqrt(1 - arc))


def retailer_lookup_by_name(retailers: list[dict]) -> dict[str, dict]:
    lookup: dict[str, dict] = {}
    for retailer in retailers:
        name = (retailer.get("name") or "").strip().lower()
        if name and name not in lookup:
            lookup[name] = retailer
    return lookup


def retailer_address_text(retailer: dict) -> str | None:
    parts = [retailer.get("address"), retailer.get("city"), retailer.get("state"), retailer.get("zip")]
    text = ", ".join(str(part).strip() for part in parts if part)
    return text or None


def retailer_distance_miles(retailer: dict) -> float | None:
    latitude = retailer.get("latitude")
    longitude = retailer.get("longitude")
    if latitude in {None, ""} or longitude in {None, ""}:
        return None
    return round(
        haversine_miles(
            REFERENCE_ADDRESS_LATITUDE,
            REFERENCE_ADDRESS_LONGITUDE,
            float(latitude),
            float(longitude),
        ),
        2,
    )


def source_distance_text(source: dict) -> str:
    distance_miles = source.get("retailerDistanceMiles")
    distance_band_miles = source.get("retailerDistanceBandMiles")
    if distance_miles is not None:
        return f"{distance_miles:.2f}mi"
    if distance_band_miles is not None:
        return f"{distance_band_miles:.1f}mi band"
    return "distance unavailable"


def source_summary_text(source: dict) -> str:
    return f"{source['label']} (${money(source['price'])}; {source_distance_text(source)})"


def source_csv_text(source: dict) -> str:
    address = source.get("dispensaryAddress")
    address_suffix = f" - {address}" if address else ""
    return f"{source_summary_text(source)}{address_suffix}"


def quantile_value(values: list[float], fraction: float) -> float:
    if not values:
        raise ValueError("quantile_value requires at least one value")
    if len(values) == 1:
        return values[0]
    position = (len(values) - 1) * fraction
    lower_index = math.floor(position)
    upper_index = math.ceil(position)
    if lower_index == upper_index:
        return values[lower_index]
    lower_value = values[lower_index]
    upper_value = values[upper_index]
    weight = position - lower_index
    return lower_value + (upper_value - lower_value) * weight


def compact_currency(value: float) -> str:
    return f"${money(value)}"


def distance_bucket(distance_miles: float | None) -> str:
    if distance_miles is None:
        return "unknown"
    if distance_miles <= 0.5:
        return "d050"
    if distance_miles <= 1.0:
        return "d100"
    if distance_miles <= 2.0:
        return "d200"
    if distance_miles <= 3.5:
        return "d350"
    if distance_miles <= 5.0:
        return "d500"
    return "d999"


def compact_override_note(note: str | None) -> str | None:
    if not note:
        return None
    lowered = note.lower()
    if "promo" in lowered:
        return note
    if "manual reviewer override" in lowered:
        return note.replace("Manual reviewer override: ", "")
    return note


def normalized_brand_key(brand_name: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (brand_name or "").lower())


def manual_price_override(row: dict, computed_price: float) -> tuple[float | None, str | None]:
    brand_name = ((row.get("brand") or {}).get("name") or "").strip()
    brand_key = normalized_brand_key(brand_name)
    profile = row_format_profile(row)
    variant_label = profile["variantLabel"]

    if brand_key in PRICE_HOLD_BRAND_KEYS:
        current_price = float(row["price"])
        return current_price, f"Manual reviewer override: Hold {brand_name} at its current ${money(current_price)} for now."

    if brand_key == "effects" and variant_label == "1g":
        current_price = float(row["price"])
        return current_price, "Manual reviewer override: Keep Effects 1g priced as-is."

    if brand_key == "grassroots" and variant_label == "1g":
        return 21.5, "Manual reviewer override: Keep Grass Roots 1g at $21.50."

    if brand_key == "mfny" and variant_label == "4x 0.75g" and not profile["isInfused"]:
        current_price = float(row["price"])
        return current_price, "Manual reviewer override: Keep the MFNY 4x 0.75g non-infused multipacks priced as-is."

    if brand_key == "mfny" and variant_label == "0.75g":
        return MFNY_SINGLE_075G_OVERRIDE_PRICE, "Manual reviewer override: Set MFNY 0.75g to $22.00 even."

    if brand_key == "presidential" and variant_label == "2g":
        current_price = float(row["price"])
        return current_price, "Manual reviewer override: Keep Presidential 2g priced as-is."

    if brand_key == "revertcannabis" and profile["packCount"] > 1:
        return 25.0, "Manual reviewer override: Keep Revert multipacks at $25.00."

    if brand_key in {"hepworth", "oyeah"} and variant_label == "5x 0.5g" and profile["isInfused"]:
        return 42.5, f"Manual reviewer override: Set {brand_name} infused 5-packs to $42.50."

    return None, None


def export_sort_key(row: dict) -> tuple[str, str, int]:
    return (row["brand"].lower(), row["productName"].lower(), int(row["productId"]))


LITALERTS_BEARER_TOKEN_PATH = Path("/Users/amp-local/.secret/litalerts/bearer-token")


@functools.lru_cache(maxsize=1)
def refreshed_litalerts_access_token() -> str:
    # Prefer the operator-installed bearer token at the canonical secret path.
    # The legacy InitiateAuth+REFRESH_TOKEN_AUTH path documented below now returns
    # HTTP 400 against the migrated Cognito user pool (see docs/litalerts/foundations.md
    # "Cognito Refresh Path Migration"). The current working refresh shape is
    # GetTokensFromRefreshToken with a flat body, but it requires a refresh token
    # captured after the AWS Amplify SDK upgrade, which is not present in older HARs.
    # Until a script-side migration to GetTokensFromRefreshToken lands, recover by
    # writing a fresh bearer into LITALERTS_BEARER_TOKEN_PATH from a current
    # brands.litalerts.com HAR.
    if LITALERTS_BEARER_TOKEN_PATH.exists():
        token = LITALERTS_BEARER_TOKEN_PATH.read_text().strip()
        if token:
            return token
    raise RuntimeError(
        f"No Lit Alerts bearer token at {LITALERTS_BEARER_TOKEN_PATH}. Drop a fresh "
        "brands.litalerts.com HAR and write its Authorization bearer (or refreshed "
        "AccessToken from the GetTokensFromRefreshToken Cognito call) into that path."
    )


def provider_post_json(url: str, headers: dict[str, str], payload: dict) -> dict:
    def send(active_headers: dict[str, str]) -> dict:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=active_headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))

    try:
        return send(headers)
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            refreshed_litalerts_access_token.cache_clear()
            retry_headers = dict(headers)
            retry_headers["authorization"] = f"Bearer {refreshed_litalerts_access_token()}"
            return send(retry_headers)
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Competitor provider request failed with HTTP {exc.code}: {body[:300]}") from exc


def provider_get_json(url: str, headers: dict[str, str]) -> dict:
    def send(active_headers: dict[str, str]) -> dict:
        request = urllib.request.Request(url, headers=active_headers, method="GET")
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))

    try:
        return send(headers)
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            refreshed_litalerts_access_token.cache_clear()
            retry_headers = dict(headers)
            retry_headers["authorization"] = f"Bearer {refreshed_litalerts_access_token()}"
            return send(retry_headers)
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Competitor provider request failed with HTTP {exc.code}: {body[:300]}") from exc


def dedupe_sources(sources: list[dict]) -> list[dict]:
    deduped: list[dict] = []
    seen: set[tuple[str, float, str]] = set()
    for source in sources:
        key = (source["label"], round(float(source["price"]), 2), source.get("url", ""))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(source)
    return deduped


def provider_headers_from_entry(entry: dict) -> dict[str, str]:
    headers = {}
    for header in entry["request"].get("headers", []):
        lowered = header["name"].lower()
        if lowered in {"content-type", "origin", "referer"}:
            headers[header["name"]] = header["value"]
    headers["authorization"] = f"Bearer {refreshed_litalerts_access_token()}"
    return headers


@functools.lru_cache(maxsize=1)
def statewide_brand_lookup_payload() -> tuple[str, dict[str, str]]:
    payload = json.loads(COMPETITOR_AUTH_ARCHIVE_PATH.read_text())
    for entry in payload["log"].get("entries") or []:
        if "Manufacturers/real" in entry["request"]["url"]:
            return entry["request"]["url"], provider_headers_from_entry(entry)
    raise RuntimeError("Could not find Lit Alerts Manufacturers/real request in the auth archive")


@functools.lru_cache(maxsize=1)
def statewide_brand_rows() -> tuple[dict, ...]:
    request_url, headers = statewide_brand_lookup_payload()
    response = provider_get_json(request_url, headers)
    return tuple(response.get("manufacturers") or [])


@functools.lru_cache(maxsize=None)
def statewide_brand_ids_for_name(brand_name: str) -> tuple[int, ...]:
    target_brand_key = normalized_brand_key(brand_name)
    if not target_brand_key:
        return ()

    scored_matches = []
    for row in statewide_brand_rows():
        candidate_key = normalized_brand_key(row.get("name") or "")
        if not candidate_key:
            continue
        if target_brand_key != candidate_key and target_brand_key not in candidate_key and candidate_key not in target_brand_key:
            continue
        scored_matches.append(
            (
                0 if target_brand_key == candidate_key else 1,
                abs(len(candidate_key) - len(target_brand_key)),
                len(candidate_key),
                int(row["id"]),
            )
        )

    scored_matches.sort()
    return tuple(match[-1] for match in scored_matches[:5])


@functools.lru_cache(maxsize=1)
def statewide_exact_request_template() -> tuple[str, dict[str, str], dict]:
    payload = json.loads(COMPETITOR_PROVIDER_STATEWIDE_EXACT_HAR_PATH.read_text())
    entry = payload["log"]["entries"][0]
    return entry["request"]["url"], provider_headers_from_entry(entry), json.loads(entry["request"]["postData"]["text"])


def product_search_term(product_name: str, brand_name: str, size_name: str | None) -> str:
    text = (product_name or "").strip()
    if brand_name and text.lower().startswith(brand_name.lower()):
        text = text[len(brand_name) :]
    if size_name:
        text = text.replace(size_name, " ")
    text = re.sub(r"[|/]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" -")
    return text or (product_name or "").strip()


def source_subcategory_label(source: dict) -> str | None:
    return source.get("subcategory") or None


def source_metadata_lines(source: dict) -> list[str]:
    medrec = []
    if source.get("medical"):
        medrec.append("medical")
    if source.get("recreational"):
        medrec.append("recreational")
    category_parts = [source.get("category") or ""]
    if source_subcategory_label(source):
        category_parts.append(source_subcategory_label(source))
    lines = [
        f"Brand: {source['brand']}" if source.get("brand") else "",
        " / ".join(part for part in category_parts if part),
        f"Quantity: {source['quantity']}" if source.get("quantity") not in {None, ''} else "",
        f"Days on menu: {source['daysOnMenu']}" if source.get("daysOnMenu") not in {None, ''} else "",
        f"Availability: {', '.join(medrec)}" if medrec else "",
        f"Source: {source['sourceType']}" if source.get("sourceType") else "",
    ]
    return [line for line in lines if line]


def parse_price_text(price_text: str | int | float | None) -> float | None:
    if price_text is None:
        return None
    cleaned = str(price_text).strip().replace("$", "").replace(",", "")
    if not cleaned:
        return None
    return float(cleaned)


def retailer_match_count(sources: list[dict]) -> int:
    return len({source.get("dispensaryName") for source in sources if source.get("dispensaryName")})


def provider_coverage_is_acceptable(provider_sources: list[dict]) -> bool:
    return (
        retailer_match_count(provider_sources) >= COMPETITOR_PROVIDER_MIN_RETAILERS
        or len(provider_sources) >= COMPETITOR_PROVIDER_TARGET_MATCHES
    )


def should_exclude_competitor_retailer(retailer_name: str | None) -> bool:
    normalized = (retailer_name or "").strip().lower()
    return any(cue in normalized for cue in EXCLUDED_COMPETITOR_RETAILER_NAME_CUES)


def fetch_provider_retailer_sets() -> dict:
    payload = json.loads(COMPETITOR_RADIUS_PROVIDER_HAR_PATH.read_text())
    entry = payload["log"]["entries"][0]
    request_body = json.loads(entry["request"]["postData"]["text"])
    headers = provider_headers_from_entry(entry)

    radii: list[dict] = []
    for radius in COMPETITOR_PROVIDER_RADIUS_STEPS:
        radius_request = copy.deepcopy(request_body)
        radius_request["ZipRadiusFilter"]["Radius"] = radius
        progress(f"Lit Alerts retailer discovery: radius {radius:.1f}mi")
        retailers = provider_post_json(entry["request"]["url"], headers, radius_request) or []
        retailers = [row for row in retailers if not should_exclude_competitor_retailer(row.get("name"))]
        radii.append(
            {
                "radiusMiles": radius,
                "retailerCount": len(retailers),
                "retailers": retailers,
                "dispensaryIds": [row["id"] for row in retailers],
            }
        )
        progress(f"Lit Alerts retailer discovery: radius {radius:.1f}mi -> {len(retailers)} retailers")

    return {
        "sourceHar": COMPETITOR_RADIUS_PROVIDER_HAR_PATH.name,
        "requestUrl": entry["request"]["url"],
        "requestTemplate": request_body,
        "radii": radii,
    }


def fetch_provider_sources_for_term(
    request_url: str,
    headers: dict[str, str],
    request_body: dict,
    retailers_by_name: dict[str, dict],
    radius_miles: float,
    search_term: str,
) -> tuple[int, int, list[dict]]:
    search_request = copy.deepcopy(request_body)
    search_request["filters"]["Name"] = search_term
    page = 0
    raw_listing_count = 0
    pages_fetched = 0
    filtered_sources: list[dict] = []

    while True:
        search_request["page"] = page
        response = provider_post_json(request_url, headers, search_request)
        listings = response.get("listings") or []
        if not listings:
            break
        raw_listing_count += len(listings)
        pages_fetched += 1
        for item in listings:
            if (item.get("category") or "").lower() != "pre-rolls":
                continue
            retailer = retailers_by_name.get((item.get("dispensaryName") or "").strip().lower(), {})
            for config in item.get("configs") or []:
                price_value = parse_price_text(config.get("salePrice") or config.get("price"))
                if price_value is None:
                    continue
                profile = source_format_profile(item.get("name") or "", config.get("weight"))
                filtered_sources.append(
                    {
                        "label": f"{item.get('dispensaryName') or 'Nearby menu'} - {item.get('name') or 'Unnamed product'}",
                        "price": round(price_value, 2),
                        "url": item.get("url") or "",
                        "sourceType": "provider-nearby-menu",
                        "dispensaryName": item.get("dispensaryName") or None,
                        "dispensaryId": retailer.get("id"),
                        "dispensaryAddress": retailer_address_text(retailer),
                        "brand": item.get("brand") or "",
                        "category": item.get("category") or "",
                        "subcategory": item.get("subCategory") or item.get("subcategory") or profile["displaySubcategory"],
                        "normalizedBrandName": normalized_brand_key(item.get("brand") or ""),
                        "normalizedBrandContext": normalized_brand_context(item.get("brand"), item.get("name")),
                        "normalizedCultivar": normalize_cultivar_name(item.get("name") or "", item.get("brand") or "", config.get("weight")),
                        "retailerDistanceMiles": retailer_distance_miles(retailer),
                        "retailerDistanceBandMiles": radius_miles,
                        "packCount": profile["packCount"],
                        "perUnitGrams": profile["perUnitGrams"],
                        "totalGrams": profile["totalGrams"],
                        "isInfused": profile["isInfused"],
                        "isBlunt": profile["isBlunt"],
                        "baseLane": profile["baseLane"],
                        "displaySubcategory": profile["displaySubcategory"],
                        "formatLaneKey": profile["formatLaneKey"],
                        "quantity": config.get("quantity"),
                        "daysOnMenu": config.get("daysOnMenu"),
                        "medical": config.get("medical"),
                        "recreational": config.get("recreational"),
                    }
                )

        if len(listings) < COMPETITOR_PROVIDER_PAGE_SIZE:
            break
        page += 1

    return raw_listing_count, pages_fetched, filtered_sources


def fetch_provider_market_data(retailer_sets: dict, search_terms: tuple[str, ...]) -> dict:
    payload = json.loads(COMPETITOR_PROVIDER_HAR_PATH.read_text())
    entry = payload["log"]["entries"][0]
    request_template = json.loads(entry["request"]["postData"]["text"])
    request_template["pagesize"] = COMPETITOR_PROVIDER_PAGE_SIZE
    headers = provider_headers_from_entry(entry)

    radius_markets: list[dict] = []
    for radius_info in retailer_sets["radii"]:
        progress(
            f"Lit Alerts menu search: radius {radius_info['radiusMiles']:.1f}mi across "
            f"{len(search_terms)} terms and {radius_info['retailerCount']} retailers"
        )
        request_body = copy.deepcopy(request_template)
        request_body["dispensaryIDs"] = radius_info["dispensaryIds"]
        request_body["filters"]["Dispensary"] = json.dumps(radius_info["dispensaryIds"], separators=(",", ":"))
        retailers_by_name = retailer_lookup_by_name(radius_info["retailers"])

        raw_listing_count = 0
        pages_fetched = 0
        filtered_sources: list[dict] = []

        max_workers = min(COMPETITOR_PROVIDER_MAX_WORKERS, len(search_terms)) or 1
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_term = {
                executor.submit(
                    fetch_provider_sources_for_term,
                    entry["request"]["url"],
                    headers,
                    request_body,
                    retailers_by_name,
                    radius_info["radiusMiles"],
                    search_term,
                ): search_term
                for search_term in search_terms
            }
            for future in concurrent.futures.as_completed(future_to_term):
                search_term = future_to_term[future]
                term_raw_listing_count, term_pages_fetched, term_filtered_sources = future.result()
                raw_listing_count += term_raw_listing_count
                pages_fetched += term_pages_fetched
                filtered_sources.extend(term_filtered_sources)
                progress(
                    f"Lit Alerts menu search: radius {radius_info['radiusMiles']:.1f}mi term {search_term!r} -> "
                    f"{term_pages_fetched} page(s), {len(term_filtered_sources)} preroll sources"
                )

        filtered_sources = dedupe_sources(filtered_sources)
        filtered_sources.sort(key=lambda source: (source["price"], source["label"]))
        progress(
            f"Lit Alerts menu search: radius {radius_info['radiusMiles']:.1f}mi complete -> "
            f"{pages_fetched} page(s), {len(filtered_sources)} unique sources"
        )

        radius_markets.append(
            {
                "radiusMiles": radius_info["radiusMiles"],
                "retailerCount": radius_info["retailerCount"],
                "dispensaryIds": radius_info["dispensaryIds"],
                "pagesFetched": pages_fetched,
                "rawListingCount": raw_listing_count,
                "matchingListingCount": len(filtered_sources),
                "sources": filtered_sources,
            }
        )

    return {
        "sourceHar": COMPETITOR_PROVIDER_HAR_PATH.name,
        "requestUrl": entry["request"]["url"],
        "requestFilters": request_template.get("filters") or {},
        "searchTerms": list(search_terms),
        "radiusMarkets": radius_markets,
    }


def provider_strategy_note(strategy: str, provider_selection: dict) -> str:
    provider_sources = provider_selection["providerSources"]
    dispensary_count = provider_selection["providerRetailerMatchCount"]
    radius_miles = provider_selection["providerRadiusMiles"]
    if strategy == "provider-brand-format-exact":
        return (
            "Nearby competitor pricing is primarily from the Lit Alerts provider using same-brand preroll listings"
            f" with the same format lane and pack structure inside the {radius_miles:.1f}-mile Midtown search radius"
            f" across {len(provider_sources)} nearby menu listing(s) from {dispensary_count} store(s)."
        )
    if strategy == "provider-brand-format-family":
        return (
            "Nearby competitor pricing is primarily from the Lit Alerts provider using the same-brand preroll family"
            f" inside the {radius_miles:.1f}-mile Midtown search radius across {len(provider_sources)} nearby menu"
            f" listing(s) from {dispensary_count} store(s) because the exact cultivar did not surface consistently nearby."
        )
    if strategy == "provider-none":
        return (
            "No reliable same-brand, same-format Lit Alerts listings surfaced from the nearby or statewide searches for this preroll family, so"
            " the packet keeps the current price instead of repricing from unrelated market comps."
        )
    if strategy == "provider-statewide-brand-format-exact":
        return (
            "Nearby same-brand comps were too thin, so this uses the statewide Lit Alerts brand/product lookup flow to"
            f" price from exact same-brand, same-format listings across {len(provider_sources)} listing(s)."
        )
    if strategy == "provider-statewide-brand-format-family":
        return (
            "Nearby same-brand comps were too thin, so this uses the statewide Lit Alerts brand lookup flow to price from"
            f" same-brand, same-format family listings across {len(provider_sources)} listing(s)."
        )
    if strategy in {"provider-statewide-thin-brand-format-exact", "provider-statewide-thin-brand-format-family"}:
        return (
            "Nearby same-brand comps were too thin, and the statewide Lit Alerts brand/product lookup only surfaced a"
            f" light same-brand, same-format read across {len(provider_sources)} listing(s)."
        )
    return (
        "Nearby competitor pricing surfaced from the Lit Alerts provider as same-brand, same-format evidence, but only"
        f" with thin nearby coverage inside the {radius_miles:.1f}-mile Midtown search radius, so treat it as a light"
        " signal rather than a full neighborhood read."
    )


def fetch_statewide_sources_for_search_term(brand_ids: tuple[int, ...], search_term: str) -> list[dict]:
    request_url, headers, request_template = statewide_exact_request_template()
    search_request = copy.deepcopy(request_template)
    search_request["brandIDs"] = list(brand_ids)
    search_request["page"] = 0
    search_request["pagesize"] = 100
    search_request["dispensaryIDs"] = None
    search_request["stateID"] = LITALERTS_STATE_ID
    search_request["filters"]["Name"] = search_term
    search_request["filters"]["Brand"] = json.dumps(list(brand_ids), separators=(",", ":"))
    search_request["filters"]["CategoryId"] = LITALERTS_PREROLLS_CATEGORY_ID
    search_request["filters"]["StateID"] = str(LITALERTS_STATE_ID)
    search_request["filters"].pop("Dispensary", None)

    page = 0
    collected_sources: list[dict] = []
    while True:
        search_request["page"] = page
        response = provider_post_json(request_url, headers, search_request)
        listings = response.get("listings") or []
        if not listings:
            break
        for item in listings:
            if (item.get("category") or "").lower() != "pre-rolls":
                continue
            for config in item.get("configs") or []:
                price_value = parse_price_text(config.get("salePrice") or config.get("price"))
                if price_value is None:
                    continue
                profile = source_format_profile(item.get("name") or "", config.get("weight"))
                collected_sources.append(
                    {
                        "label": f"{item.get('dispensaryName') or 'Statewide menu'} - {item.get('name') or 'Unnamed product'}",
                        "price": round(price_value, 2),
                        "url": item.get("url") or "",
                        "sourceType": "provider-statewide-brand-search",
                        "dispensaryName": item.get("dispensaryName") or None,
                        "dispensaryId": None,
                        "dispensaryAddress": None,
                        "brand": item.get("brand") or "",
                        "category": item.get("category") or "",
                        "subcategory": item.get("subCategory") or item.get("subcategory") or profile["displaySubcategory"],
                        "normalizedBrandName": normalized_brand_key(item.get("brand") or ""),
                        "normalizedBrandContext": normalized_brand_context(item.get("brand"), item.get("name")),
                        "normalizedCultivar": normalize_cultivar_name(item.get("name") or "", item.get("brand") or "", config.get("weight")),
                        "retailerDistanceMiles": None,
                        "retailerDistanceBandMiles": None,
                        "packCount": profile["packCount"],
                        "perUnitGrams": profile["perUnitGrams"],
                        "totalGrams": profile["totalGrams"],
                        "isInfused": profile["isInfused"],
                        "isBlunt": profile["isBlunt"],
                        "baseLane": profile["baseLane"],
                        "displaySubcategory": profile["displaySubcategory"],
                        "formatLaneKey": profile["formatLaneKey"],
                        "quantity": config.get("quantity"),
                        "daysOnMenu": config.get("daysOnMenu"),
                        "medical": config.get("medical"),
                        "recreational": config.get("recreational"),
                    }
                )
        if len(listings) < int(search_request["pagesize"]):
            break
        page += 1

    return dedupe_sources(collected_sources)


def select_statewide_provider_sources_for_family(family_rows: list[dict]) -> tuple[list[dict], str]:
    brand_name = family_rows[0]["brand"]["name"]
    brand_ids = statewide_brand_ids_for_name(brand_name)
    if not brand_ids:
        return [], "provider-none"

    search_terms = tuple(
        dict.fromkeys(
            product_search_term(row["name"], row["brand"]["name"], row["size"]["name"])
            for row in family_rows
        )
    )
    statewide_sources: list[dict] = []
    for search_term in search_terms:
        statewide_sources.extend(fetch_statewide_sources_for_search_term(brand_ids, search_term))
    statewide_sources = dedupe_sources(statewide_sources)
    if not statewide_sources:
        return [], "provider-none"

    target_profile = row_format_profile(family_rows[0])
    format_sources = [
        source for source in statewide_sources if same_lane_key(target_profile, source) and pack_structure_matches(target_profile, source)
    ]
    target_cultivars = [
        normalize_cultivar_name(row["name"], row["brand"]["name"], row["size"]["name"]) for row in family_rows
    ]
    exact_sources = dedupe_sources(
        [
            source
            for source in format_sources
            if any(is_exactish_provider_match(target, source["normalizedCultivar"]) for target in target_cultivars)
        ]
    )
    if len(exact_sources) >= COMPETITOR_PROVIDER_EXACT_MATCH_MIN_SOURCES:
        return exact_sources, "provider-statewide-brand-format-exact"
    if len(format_sources) >= COMPETITOR_PROVIDER_BRAND_FAMILY_MIN_SOURCES:
        return dedupe_sources(format_sources), "provider-statewide-brand-format-family"
    if exact_sources:
        return exact_sources, "provider-statewide-thin-brand-format-exact"
    if format_sources:
        return dedupe_sources(format_sources), "provider-statewide-thin-brand-format-family"
    return [], "provider-none"


def select_provider_sources_within_market(family_rows: list[dict], provider_market: dict) -> tuple[list[dict], str]:
    target_profile = row_format_profile(family_rows[0])
    brand_name = family_rows[0]["brand"]["name"]
    all_sources = provider_market["sources"]
    lane_sources = [source for source in all_sources if same_lane_key(target_profile, source)]
    format_sources = [source for source in lane_sources if pack_structure_matches(target_profile, source)]
    brand_format_sources = dedupe_sources([source for source in format_sources if source_matches_brand(brand_name, source)])

    target_cultivars = [
        normalize_cultivar_name(row["name"], row["brand"]["name"], row["size"]["name"]) for row in family_rows
    ]
    exact_sources = [
        source
        for source in brand_format_sources
        if any(is_exactish_provider_match(target, source["normalizedCultivar"]) for target in target_cultivars)
    ]
    exact_sources = dedupe_sources(exact_sources)

    if len(exact_sources) >= COMPETITOR_PROVIDER_EXACT_MATCH_MIN_SOURCES:
        return exact_sources, "provider-brand-format-exact"
    if len(brand_format_sources) >= COMPETITOR_PROVIDER_BRAND_FAMILY_MIN_SOURCES:
        return list(brand_format_sources), "provider-brand-format-family"
    if exact_sources:
        return exact_sources, "provider-thin-brand-format-exact"
    if brand_format_sources:
        return list(brand_format_sources), "provider-thin-brand-format-family"
    return [], "provider-none"


def select_provider_sources_for_family(family_rows: list[dict], provider_market: dict) -> dict:
    selected: dict | None = None
    for radius_market in provider_market["radiusMarkets"]:
        provider_sources, provider_strategy = select_provider_sources_within_market(family_rows, radius_market)
        if not provider_sources:
            continue
        selected = {
            "providerSources": provider_sources,
            "providerStrategy": provider_strategy,
            "providerRadiusMiles": radius_market["radiusMiles"],
            "providerRetailerMatchCount": retailer_match_count(provider_sources),
            "providerMatchCount": len(provider_sources),
            "providerRadiusRetailerUniverseCount": radius_market["retailerCount"],
        }
        if provider_coverage_is_acceptable(provider_sources):
            break

    if selected:
        return selected

    statewide_sources, statewide_strategy = select_statewide_provider_sources_for_family(family_rows)
    if statewide_sources:
        return {
            "providerSources": statewide_sources,
            "providerStrategy": statewide_strategy,
            "providerRadiusMiles": None,
            "providerRetailerMatchCount": retailer_match_count(statewide_sources),
            "providerMatchCount": len(statewide_sources),
            "providerRadiusRetailerUniverseCount": 0,
        }

    return {
        "providerSources": [],
        "providerStrategy": "provider-none",
        "providerRadiusMiles": None,
        "providerRetailerMatchCount": 0,
        "providerMatchCount": 0,
        "providerRadiusRetailerUniverseCount": 0,
    }


def build_family_pricing_evidence(source_rows: list[dict], provider_market: dict) -> dict[tuple[str, str, str, float], dict]:
    rows_by_family: dict[tuple[str, str, str, float], list[dict]] = defaultdict(list)
    for row in source_rows:
        rows_by_family[pricing_family_key(row)].append(row)

    evidence_by_family: dict[tuple[str, str, str, float], dict] = {}
    for family_key, family_rows in rows_by_family.items():
        provider_selection = select_provider_sources_for_family(family_rows, provider_market)
        provider_sources = provider_selection["providerSources"]
        provider_strategy = provider_selection["providerStrategy"]
        selected_sources = dedupe_sources(list(provider_sources))
        strategy = provider_strategy
        note = provider_strategy_note(strategy, provider_selection)

        if selected_sources:
            average_price = round(sum(source["price"] for source in selected_sources) / len(selected_sources), 2)
        else:
            average_price = round(sum(float(row["price"]) for row in family_rows) / len(family_rows) / POST_TAX_MULTIPLIER, 2)
        evidence_by_family[family_key] = {
            "averageCompetitorPrice": average_price,
            "sources": selected_sources,
            "note": note,
            "strategy": strategy,
            "sourceCount": len(selected_sources),
            "providerRadiusMiles": provider_selection["providerRadiusMiles"],
            "providerRetailerMatchCount": provider_selection["providerRetailerMatchCount"],
            "providerMatchCount": provider_selection["providerMatchCount"],
        }

    return evidence_by_family


def source_product_name_from_source(source: dict) -> str:
    label = (source.get("label") or "").strip()
    if not label:
        return ""
    dispensary_name = (source.get("dispensaryName") or "").strip()
    prefix = f"{dispensary_name} - " if dispensary_name else ""
    if prefix and label.startswith(prefix):
        return label[len(prefix) :].strip()
    if " - " in label:
        return label.split(" - ", 1)[-1].strip()
    return label


def display_sources_for_row(row: dict, evidence: dict) -> list[dict]:
    sources = list(evidence["sources"])
    if not sources:
        return []

    target_cultivar = normalize_cultivar_name(row["name"], row["brand"]["name"], row["size"]["name"])
    exact_sources = [
        source
        for source in sources
        if is_exactish_provider_match(target_cultivar, normalize_match_text(source_product_name_from_source(source)))
    ]
    if exact_sources:
        return dedupe_sources(exact_sources)
    if evidence.get("strategy") in {
        "provider-brand-format-family",
        "provider-thin-brand-format-family",
        "provider-statewide-brand-format-family",
        "provider-statewide-thin-brand-format-family",
    }:
        return dedupe_sources(sources)
    return []


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def money(value: float | int | None) -> str:
    if value is None:
        return ""
    return f"{float(value):.2f}"


def read_latest_subset() -> tuple[dict, list[dict]]:
    payload = json.loads(SOURCE_HAR_PATH.read_text())
    entries = payload["log"].get("entries") or []
    if not entries:
        raise RuntimeError(f"No entries found in {SOURCE_HAR_PATH.name}")
    ensure_state_context()
    request_params = copy.deepcopy(SUBSET_REQUEST_PARAMS)
    result = analysis.api_call("store.product.list.short", request_params)
    rows = result.get("data") or []
    filtered_rows = [row for row in rows if ((row.get("brand") or {}).get("name") or "").strip()]
    if len(filtered_rows) != len(rows):
        progress(f"Skipped {len(rows) - len(filtered_rows)} live preroll rows with no brand metadata")
    return request_params, filtered_rows


def ensure_state_context() -> dict:
    result = analysis.api_call("store.auth.dealer.set", {"dealerId": STATE_DEALER_ID})
    user = result.get("user") or {}
    if user.get("currentDealerId") != STATE_DEALER_ID:
        raise RuntimeError(
            f"Expected state dealer {STATE_DEALER_ID}, got {user.get('currentDealerId')} {user.get('currentDealerName')}"
        )
    return {
        "dealerId": user["currentDealerId"],
        "dealerName": user["currentDealerName"],
    }


def fetch_all_strains() -> tuple[dict[str, dict], dict]:
    state_context = ensure_state_context()
    rows = analysis.api_call("store.product.strain.list", {"page": 1, "pageSize": 1_000_000})["data"]
    return {row["name"].lower(): row for row in rows}, state_context


def fetch_group_details(group_ids: list[int]) -> dict[int, dict]:
    ensure_state_context()
    details: dict[int, dict] = {}
    unique_group_ids = sorted(set(group_ids))
    for index, group_id in enumerate(unique_group_ids, start=1):
        group = analysis.api_call("store.product.group.get", {"id": group_id})
        images = group.get("images") or []
        details[group_id] = {
            "imageUrl": images[0]["url"] if images else "",
            "imageCount": len(images),
            "descriptionPresent": bool((group.get("description") or "").strip()),
        }
        if index == 1 or index % 25 == 0 or index == len(unique_group_ids):
            progress(f"Sweed group detail fetch: {index}/{len(unique_group_ids)}")
    return details


def gm_percent(cost: float, price: float) -> float:
    return round((1 - POST_TAX_MULTIPLIER * cost / price) * 100, 2)


def round_up_to_half(value: float) -> float:
    return math.ceil(value * 2 - 1e-9) / 2


def round_down_to_half(value: float) -> float:
    return math.floor(value * 2 + 1e-9) / 2


def minimum_price_for_gm(cost: float, gm_percent_target: float) -> float:
    return round_up_to_half(POST_TAX_MULTIPLIER * cost / (1 - gm_percent_target / 100))


def maximum_price_for_gm(cost: float, gm_percent_target: float) -> float:
    return round_down_to_half(POST_TAX_MULTIPLIER * cost / (1 - gm_percent_target / 100))


def competitor_post_tax_price(average_competitor_price: float) -> float:
    return round(average_competitor_price * POST_TAX_MULTIPLIER, 2)


def competitor_target_price(average_competitor_price: float) -> float:
    return round_down_to_half(competitor_post_tax_price(average_competitor_price) * COMPETITOR_PRICE_DISCOUNT_FACTOR)


def clean_prevalence_label(value: str | None) -> str | None:
    if not value:
        return None
    aliases = {
        "Indica Hybrid": "Indica Dominant",
        "Indica Leaning Hybrid": "Indica Dominant",
        "Sativa Hybrid": "Sativa Dominant",
        "Sativa Dominant Hybrid": "Sativa Dominant",
    }
    return aliases.get(value, value)


def fallback_target_from_group_name(group_name: str, current_strain_name: str | None) -> str | None:
    normalized = analysis.normalize_group_name(group_name)
    lowered = normalized.lower()
    if lowered in {"", "hybrid", "indica", "sativa"}:
        return None
    if "blend" in lowered:
        return None
    if current_strain_name and current_strain_name == normalized:
        return normalized
    return normalized


def build_catalog_proposal(row: dict, strains_by_name: dict[str, dict]) -> dict:
    group_name = row["productGroup"]["name"]
    product_name = row["name"]
    current_strain_name = ((row.get("strain") or {}).get("name") or None)
    normalized_group_name = analysis.normalize_group_name(group_name)

    target_strain_name = analysis.infer_target_strain_name(group_name, product_name, strains_by_name)
    if not target_strain_name and current_strain_name in analysis.GENERIC_STRAIN_NAMES | {None}:
        target_strain_name = fallback_target_from_group_name(group_name, current_strain_name)

    target_strain_row = strains_by_name.get(target_strain_name.lower()) if target_strain_name else None
    inference = INFERENCE_BY_LOWER.get(normalized_group_name.lower())
    verified = (
        VERIFIED_BY_LOWER.get((target_strain_name or "").lower())
        or VERIFIED_BY_LOWER.get((current_strain_name or "").lower())
    )

    target_prevalence = None
    proposed_effects: list[str] = []
    proposed_flavors: list[str] = []
    proposed_terpenes: list[str] = []
    source_status = "generic-or-missing"
    source_note = ""

    if inference:
        target_prevalence = clean_prevalence_label(inference.get("prevalence"))
        proposed_effects = inference["effects"]
        proposed_flavors = inference["flavors"]
        proposed_terpenes = inference["terpenes"]
        source_status = "reviewed-group"
        source_note = inference["source_note"]
    elif verified:
        target_prevalence = clean_prevalence_label(
            verified.get("prevalence") or ((target_strain_row or {}).get("prevalence") or {}).get("name")
        )
        proposed_effects = verified["effects"]
        proposed_flavors = verified["flavors"]
        proposed_terpenes = verified["terpenes"]
        source_status = verified["status"]
        source_note = verified["note"]
    elif target_strain_name:
        prevalence_hint = None
        if target_strain_row:
            prevalence_hint = ((target_strain_row.get("prevalence") or {}).get("name"))
        elif current_strain_name in analysis.GENERIC_STRAIN_NAMES:
            prevalence_hint = current_strain_name
        target_prevalence = clean_prevalence_label(prevalence_hint)
        source_status = "inferred-candidate"
        source_note = (
            f"The product group name `{normalized_group_name}` is a strong cultivar cue, but no reviewed Leafly-derived"
            " effect/flavor/terpene set has been recorded for it in this workspace yet."
        )
    elif current_strain_name and current_strain_name not in analysis.GENERIC_STRAIN_NAMES:
        source_status = "inferred-candidate"
        source_note = (
            f"Keep the current `{current_strain_name}` attachment for now. No safer exact or equivalent upgrade is"
            " recorded for this SKU in the current workspace notes."
        )
    else:
        source_note = (
            "No safe exact cultivar recommendation is recorded for this row in the current workspace notes, so this"
            " proposal leaves the catalog side unchanged."
        )

    if target_strain_name:
        if current_strain_name == target_strain_name:
            catalog_action = "keep-current-strain"
            catalog_reason = f"Keep the current exact strain attachment `{target_strain_name}`."
        elif current_strain_name in analysis.GENERIC_STRAIN_NAMES | {None}:
            if target_strain_row:
                catalog_action = "attach-existing-strain"
                catalog_reason = (
                    f"Replace the generic or missing strain state with the existing exact strain `{target_strain_name}`."
                )
            else:
                catalog_action = "create-and-attach-strain"
                catalog_reason = (
                    f"Create a new exact strain record for `{target_strain_name}` and attach it to the product group."
                )
        elif current_strain_name == analysis.GROUP_EQUIVALENT_STRAINS.get(normalized_group_name):
            catalog_action = "keep-equivalent-strain"
            catalog_reason = (
                f"Keep the current equivalent strain `{current_strain_name}` as the safest Sweed-side match for"
                f" `{target_strain_name}`."
            )
        elif target_strain_row:
            catalog_action = "swap-to-existing-strain"
            catalog_reason = (
                f"Swap the current `{current_strain_name}` attachment for the existing exact strain `{target_strain_name}`."
            )
        else:
            catalog_action = "create-and-attach-strain"
            catalog_reason = (
                f"Replace the current `{current_strain_name}` attachment with a new exact strain `{target_strain_name}`."
            )
    elif group_name.lower().endswith("blend"):
        catalog_action = "keep-generic-blend"
        catalog_reason = "This looks like an intentionally generic blend SKU; keep the generic blend strain state."
    elif current_strain_name and current_strain_name not in analysis.GENERIC_STRAIN_NAMES:
        catalog_action = "hold-current-strain"
        catalog_reason = f"Hold the current `{current_strain_name}` attachment until a better recorded exact mapping exists."
    else:
        catalog_action = "no-safe-change"
        catalog_reason = "No safe exact strain recommendation is recorded for this row in the current notes."

    return {
        "catalogAction": catalog_action,
        "currentStrain": current_strain_name,
        "targetStrain": target_strain_name,
        "targetStrainId": (target_strain_row or {}).get("id"),
        "targetPrevalence": target_prevalence,
        "proposedEffects": proposed_effects,
        "proposedFlavors": proposed_flavors,
        "proposedTerpenes": proposed_terpenes,
        "sourceStatus": source_status,
        "sourceNote": source_note,
        "catalogReason": catalog_reason,
    }


def build_price_proposal(row: dict, pricing_evidence_by_family: dict[tuple[str, str, str, float], dict]) -> dict:
    current_price = float(row["price"])
    current_cost = float(row["distributorProductPrice"])
    current_gm = gm_percent(current_cost, current_price)
    evidence = pricing_evidence_by_family[pricing_family_key(row)]
    row_display_sources = display_sources_for_row(row, evidence)

    competitor_average = evidence["averageCompetitorPrice"]
    competitor_post_tax = competitor_post_tax_price(competitor_average)
    competitor_target = competitor_target_price(competitor_average)
    minimum_price = minimum_price_for_gm(current_cost, TARGET_MIN_GM_PERCENT)
    maximum_price = maximum_price_for_gm(current_cost, TARGET_MAX_GM_PERCENT)
    absolute_min_price = minimum_price_for_gm(current_cost, ABSOLUTE_MIN_GM_PERCENT)

    if evidence["sources"]:
        proposed_price = competitor_target
        pricing_reason = (
            f"Observed public average for this SKU family is ${money(competitor_average)} pre-tax (${money(competitor_post_tax)}"
            f" post-tax), so the draft target lands a few percent below that post-tax average at ${money(competitor_target)}."
        )
        if proposed_price < minimum_price:
            pricing_reason += (
                f" This sits below the normal {TARGET_MIN_GM_PERCENT:.0f}% GM floor of ${money(minimum_price)},"
                " but that is allowed here because the public market average would otherwise price this row above the"
                " filtered-catalog peer set."
            )
        elif proposed_price > maximum_price:
            proposed_price = maximum_price
            pricing_reason += (
                f" The raw competitor target would push GM above the normal {TARGET_MAX_GM_PERCENT:.0f}% ceiling, so the"
                f" draft is capped at ${money(maximum_price)} to stay inside the established margin band."
            )
        if proposed_price < absolute_min_price:
            proposed_price = absolute_min_price
            pricing_reason += (
                f" The raw competitor target would drop below the hard {ABSOLUTE_MIN_GM_PERCENT:.0f}% GM floor of"
                f" ${money(absolute_min_price)}, so the draft is lifted to that floor pending explicit approval."
            )
    else:
        proposed_price = current_price
        competitor_post_tax = current_price
        pricing_reason = evidence["note"]

    override_price, override_note = manual_price_override(row, proposed_price)
    if override_price is not None:
        pricing_reason += f" {override_note}"
        proposed_price = override_price
    elif proposed_price < absolute_min_price:
        proposed_price = absolute_min_price
        pricing_reason += (
            f" The current fallback price sits below the hard {ABSOLUTE_MIN_GM_PERCENT:.0f}% GM floor of"
            f" ${money(absolute_min_price)}, so the draft is lifted to that floor pending explicit approval."
        )

    if abs(proposed_price - current_price) < 0.01:
        pricing_action = "keep-price"
    elif proposed_price > current_price:
        pricing_action = "raise-price"
    else:
        pricing_action = "lower-price"

    evidence_summary = [source_summary_text(source) for source in row_display_sources]
    evidence_source_details = [
        {
            "label": source["label"],
            "price": round(float(source["price"]), 2),
            "postTaxPrice": competitor_post_tax_price(float(source["price"])),
            "url": source.get("url") or "",
            "dispensaryName": source.get("dispensaryName"),
            "dispensaryId": source.get("dispensaryId"),
            "dispensaryAddress": source.get("dispensaryAddress"),
            "brand": source.get("brand"),
            "category": source.get("category"),
            "subcategory": source.get("subcategory"),
            "retailerDistanceMiles": source.get("retailerDistanceMiles"),
            "retailerDistanceBandMiles": source.get("retailerDistanceBandMiles"),
            "distanceBucket": distance_bucket(source.get("retailerDistanceMiles")),
            "distanceLabel": source_distance_text(source),
            "quantity": source.get("quantity"),
            "daysOnMenu": source.get("daysOnMenu"),
            "medical": source.get("medical"),
            "recreational": source.get("recreational"),
            "sourceType": source.get("sourceType"),
        }
        for source in row_display_sources
    ]

    if evidence_source_details:
        competitor_post_tax_values = sorted(detail["postTaxPrice"] for detail in evidence_source_details)
        competitor_min_post_tax = competitor_post_tax_values[0]
        competitor_max_post_tax = competitor_post_tax_values[-1]
        competitor_median_post_tax = quantile_value(competitor_post_tax_values, 0.5)
        competitor_q1_post_tax = quantile_value(competitor_post_tax_values, 0.25)
        competitor_q3_post_tax = quantile_value(competitor_post_tax_values, 0.75)
    else:
        competitor_min_post_tax = current_price
        competitor_max_post_tax = current_price
        competitor_median_post_tax = current_price
        competitor_q1_post_tax = current_price
        competitor_q3_post_tax = current_price
    pricing_domain_min = min(competitor_min_post_tax, current_price, proposed_price)
    pricing_domain_max = max(competitor_max_post_tax, current_price, proposed_price)
    pricing_domain_padding = max((pricing_domain_max - pricing_domain_min) * 0.08, 1.0)

    return {
        "currentPrice": current_price,
        "effectiveCost": current_cost,
        "currentGmPercent": current_gm,
        "averageCompetitorPrice": competitor_average,
        "averageCompetitorPostTaxPrice": competitor_post_tax,
        "proposedPrice": proposed_price,
        "proposedGmPercent": gm_percent(current_cost, proposed_price),
        "pricingAction": pricing_action,
        "pricingReason": pricing_reason,
        "pricingEvidenceNote": evidence["note"],
        "pricingEvidenceStrategy": evidence["strategy"],
        "pricingEvidenceSourceCount": len(evidence_source_details),
        "pricingEvidenceRadiusMiles": evidence["providerRadiusMiles"] if evidence_source_details else None,
        "pricingEvidenceRetailerMatchCount": retailer_match_count(row_display_sources),
        "pricingEvidenceProviderMatchCount": len(evidence_source_details),
        "pricingEvidenceReferenceAddress": f"{REFERENCE_ADDRESS_LABEL}, {REFERENCE_ADDRESS_CITY}",
        "pricingEvidenceSummary": evidence_summary,
        "pricingEvidenceUrls": [source["url"] for source in row_display_sources],
        "pricingEvidenceSourceDetails": evidence_source_details,
        "pricingOverrideNote": compact_override_note(override_note),
        "pricingBelowFloor": proposed_price < minimum_price,
        "competitorMinPostTaxPrice": round(competitor_min_post_tax, 2),
        "competitorMaxPostTaxPrice": round(competitor_max_post_tax, 2),
        "competitorMedianPostTaxPrice": round(competitor_median_post_tax, 2),
        "competitorQ1PostTaxPrice": round(competitor_q1_post_tax, 2),
        "competitorQ3PostTaxPrice": round(competitor_q3_post_tax, 2),
        "pricingDomainMin": round(pricing_domain_min - pricing_domain_padding, 2),
        "pricingDomainMax": round(pricing_domain_max + pricing_domain_padding, 2),
    }


def build_image_proposal(group_details: dict) -> dict:
    image_url = group_details.get("imageUrl") or ""
    if image_url:
        return {
            "imageAction": "keep-current-image",
            "imageUrl": image_url,
            "imageReason": "This product group already has a live catalog image attached in the state catalog.",
            "descriptionPresent": group_details.get("descriptionPresent", False),
        }
    return {
        "imageAction": "needs-image-review",
        "imageUrl": "",
        "imageReason": "No current live group image was found, so this row still needs picture sourcing before any apply pass.",
        "descriptionPresent": group_details.get("descriptionPresent", False),
    }


def flatten_row(row: dict, catalog: dict, pricing: dict, image: dict) -> dict:
    profile = row_format_profile(row)
    return {
        "productId": int(row["id"]),
        "groupId": int(row["productGroup"]["id"]),
        "brand": row["brand"]["name"],
        "productName": row["name"],
        "groupName": row["productGroup"]["name"],
        "category": row["category"]["name"],
        "subcategory": profile["displaySubcategory"],
        "liveSubcategory": ((row.get("subcategory") or {}).get("name") or ""),
        "size": row["size"]["name"],
        "variantLabel": profile["variantLabel"],
        "packCount": profile["packCount"],
        "perUnitGrams": profile["perUnitGrams"],
        "totalGrams": profile["totalGrams"],
        "isInfused": profile["isInfused"],
        "isBlunt": profile["isBlunt"],
        "formatLaneKey": profile["formatLaneKey"],
        "distributors": [d["name"] for d in row.get("distributors", []) if d.get("name")],
        **image,
        **pricing,
        **catalog,
    }


def write_csv(rows: list[dict]) -> None:
    fieldnames = [
        "brand",
        "productName",
        "groupName",
        "productId",
        "groupId",
        "liveSubcategory",
        "variantLabel",
        "packCount",
        "perUnitGrams",
        "totalGrams",
        "isInfused",
        "isBlunt",
        "imageAction",
        "imageUrl",
        "currentPrice",
        "averageCompetitorPrice",
        "averageCompetitorPostTaxPrice",
        "effectiveCost",
        "currentGmPercent",
        "proposedPrice",
        "proposedGmPercent",
        "pricingAction",
        "pricingEvidenceStrategy",
        "pricingEvidenceSourceCount",
        "pricingEvidenceRadiusMiles",
        "pricingEvidenceRetailerMatchCount",
        "pricingEvidenceProviderMatchCount",
        "pricingEvidenceReferenceAddress",
        "pricingEvidenceSummary",
        "pricingEvidenceSourceDetails",
        "pricingReason",
        "currentStrain",
        "targetStrain",
        "targetStrainId",
        "targetPrevalence",
        "catalogAction",
        "sourceStatus",
        "proposedEffects",
        "proposedFlavors",
        "proposedTerpenes",
        "catalogReason",
        "sourceNote",
        "imageReason",
        "descriptionPresent",
    ]
    with OUTPUT_CSV_PATH.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in sorted(rows, key=export_sort_key):
            csv_row = {field: row.get(field) for field in fieldnames}
            csv_row["proposedEffects"] = ", ".join(row["proposedEffects"])
            csv_row["proposedFlavors"] = ", ".join(row["proposedFlavors"])
            csv_row["proposedTerpenes"] = ", ".join(row["proposedTerpenes"])
            csv_row["pricingEvidenceSummary"] = " | ".join(row["pricingEvidenceSummary"])
            csv_row["pricingEvidenceSourceDetails"] = " | ".join(
                source_csv_text(source) for source in row["pricingEvidenceSourceDetails"]
            )
            writer.writerow(csv_row)


def chip(label: str, class_name: str) -> str:
    return f'<span class="chip {class_name}">{html.escape(label)}</span>'


def detail_page_href(row: dict) -> str:
    return f"{OUTPUT_DETAIL_DIR.name}/{int(row['productId'])}.html"


def source_product_name(source: dict) -> str:
    label = (source.get("label") or "").strip()
    if not label:
        return "-"
    dispensary_name = (source.get("dispensaryName") or "").strip()
    prefix = f"{dispensary_name} - " if dispensary_name else ""
    if prefix and label.startswith(prefix):
        return label[len(prefix) :].strip() or label
    if " - " in label:
        return label.split(" - ", 1)[-1].strip() or label
    return label


def source_match_badge(row: dict, source: dict) -> tuple[str, str]:
    target_name = normalize_match_text(row["productName"])
    target_cultivar = normalize_cultivar_name(row["productName"], row["brand"], row["size"])
    competitor_name = normalize_match_text(source_product_name(source))
    strategy = row.get("pricingEvidenceStrategy") or ""
    brand_cultivar_strategies = {
        "provider-brand-format-exact",
        "provider-brand-format-family",
        "provider-statewide-brand-format-exact",
        "provider-statewide-brand-format-family",
        "provider-thin-brand-format-exact",
        "provider-thin-brand-format-family",
        "provider-statewide-thin-brand-format-exact",
        "provider-statewide-thin-brand-format-family",
    }
    family_equivalent_strategies = {
        "provider-brand-format-family",
        "provider-thin-brand-format-family",
        "provider-statewide-brand-format-family",
        "provider-statewide-thin-brand-format-family",
    }

    if competitor_name and competitor_name == target_name:
        return "product match", "match-exact"
    if competitor_name and is_exactish_provider_match(target_cultivar, competitor_name):
        if strategy in brand_cultivar_strategies:
            return "same-brand cultivar", "match-cultivar"
        return "cultivar equivalent", "match-cultivar"
    if strategy in family_equivalent_strategies:
        return "brand+categorical equivalent", "match-family"
    return "brand+categorical equivalent", "match-equivalent"


def price_position_percent(value: float, domain_min: float, domain_max: float) -> float:
    if domain_max <= domain_min:
        return 50.0
    percent = (value - domain_min) / (domain_max - domain_min) * 100
    return max(0.0, min(100.0, percent))


def tooltip_attr(lines: list[str]) -> str:
    encoded = "&#10;".join(html.escape(line, quote=True) for line in lines if line)
    return f' title="{encoded}"' if encoded else ""


def pricing_evidence_coverage_text(row: dict) -> str:
    if not row.get("pricingEvidenceSourceDetails"):
        return "No reliable same-brand, same-format nearby comparables"
    coverage = (
        f"{row['pricingEvidenceRetailerMatchCount']} stores / "
        f"{row['pricingEvidenceProviderMatchCount']} matches"
    )
    radius_miles = row.get("pricingEvidenceRadiusMiles")
    if radius_miles is not None:
        return f"{coverage} / {radius_miles:.1f}mi"
    if (row.get("pricingEvidenceStrategy") or "").startswith("provider-statewide"):
        return f"{coverage} / statewide"
    return coverage


def render_pricing_ladder(row: dict, detail: bool = False) -> str:
    domain_min = float(row["pricingDomainMin"])
    domain_max = float(row["pricingDomainMax"])
    current_price = float(row["currentPrice"])
    proposed_price = float(row["proposedPrice"])
    market_average = float(row["averageCompetitorPostTaxPrice"])
    q1 = float(row["competitorQ1PostTaxPrice"])
    q3 = float(row["competitorQ3PostTaxPrice"])
    median = float(row["competitorMedianPostTaxPrice"])

    competitor_marks = []
    stack_counts: dict[float, int] = defaultdict(int)
    stack_base = 28 if detail else 22
    stack_gap = 10 if detail else 8
    stack_levels = 8 if detail else 3
    for source in sorted(
        row["pricingEvidenceSourceDetails"],
        key=lambda value: (
            float(value["postTaxPrice"]),
            value.get("retailerDistanceMiles") if value.get("retailerDistanceMiles") is not None else 999.0,
            value.get("dispensaryName") or value.get("label") or "",
        ),
    ):
        left = price_position_percent(float(source["postTaxPrice"]), domain_min, domain_max)
        bucket = source.get("distanceBucket") or "unknown"
        price_key = round(float(source["postTaxPrice"]), 2)
        top_offset = stack_base + (stack_counts[price_key] % stack_levels) * stack_gap
        stack_counts[price_key] += 1
        tooltip = tooltip_attr(
            [
                source.get("dispensaryName") or source.get("label") or "Competitor",
                f"Post-tax: {compact_currency(float(source['postTaxPrice']))}",
                f"Distance: {source.get('distanceLabel') or 'n/a'}",
                source.get("dispensaryAddress") or "",
                *source_metadata_lines(source),
            ]
        )
        mark = (
            f'<a class="ladder-competitor {bucket}" style="left:{left:.2f}%; top:{top_offset}px;"'
            f' href="{html.escape(source.get("url") or "#")}" target="_blank" rel="noopener noreferrer"{tooltip}></a>'
            if source.get("url")
            else f'<span class="ladder-competitor {bucket}" style="left:{left:.2f}%; top:{top_offset}px;"{tooltip}></span>'
        )
        competitor_marks.append(mark)

    current_left = price_position_percent(current_price, domain_min, domain_max)
    proposed_left = price_position_percent(proposed_price, domain_min, domain_max)
    market_average_left = price_position_percent(market_average, domain_min, domain_max)
    q1_left = price_position_percent(q1, domain_min, domain_max)
    q3_left = price_position_percent(q3, domain_min, domain_max)
    median_left = price_position_percent(median, domain_min, domain_max)

    current_tooltip = tooltip_attr(
        [
            f"Current price: {compact_currency(current_price)}",
            f"Current GM: {row['currentGmPercent']:.2f}%",
            f"Cost: {compact_currency(float(row['effectiveCost']))}",
        ]
    )
    proposed_tooltip = tooltip_attr(
        [
            f"Proposed price: {compact_currency(proposed_price)}",
            f"Proposed GM: {row['proposedGmPercent']:.2f}%",
            f"Cost: {compact_currency(float(row['effectiveCost']))}",
        ]
    )
    market_average_tooltip = tooltip_attr(
        [
            f"Market average: {compact_currency(market_average)}",
            "Post-tax average across the selected nearby competitor listings.",
        ]
    )

    shell_class = "pricing-ladder-shell is-detail" if detail else "pricing-ladder-shell"
    ladder_class = "pricing-ladder is-detail" if detail else "pricing-ladder"
    has_evidence = bool(row["pricingEvidenceSourceDetails"])
    if has_evidence:
        evidence_line = f"{compact_currency(current_price)} - {pricing_evidence_coverage_text(row)}"
        market_stats_html = (
            f"<span>Market avg {compact_currency(market_average)}</span>"
            f"<span>Median {compact_currency(median)}</span>"
            f"<span>IQR {compact_currency(q1)}-{compact_currency(q3)}</span>"
            f"<span>Range {compact_currency(float(row['competitorMinPostTaxPrice']))}-{compact_currency(float(row['competitorMaxPostTaxPrice']))}</span>"
            f"<span>{evidence_line}</span>"
        )
        market_shape_html = (
            f'<div class="ladder-iqr" style="left:{q1_left:.2f}%; width:{max(q3_left - q1_left, 0.8):.2f}%;"></div>'
            f'<div class="ladder-median" style="left:{median_left:.2f}%;"></div>'
            f"{''.join(competitor_marks)}"
            f'<div class="ladder-marker market-average" style="left:{market_average_left:.2f}%;"{market_average_tooltip}><span>Market avg</span></div>'
        )
    else:
        evidence_line = "No reliable same-brand, same-format nearby comparables"
        market_stats_html = f"<span>{html.escape(evidence_line)}</span>"
        market_shape_html = ""

    return f"""
      <div class="{shell_class}">
        <div class="pricing-ladder-head">
          <span class="metric">{compact_currency(current_price)} <span class="metric-detail">({row['currentGmPercent']:.2f}% GM)</span> -&gt; {compact_currency(proposed_price)}<span class="metric-detail"> ({row['proposedGmPercent']:.2f}% GM)</span></span>
        </div>
        <div class="{ladder_class}">
          <div class="ladder-track"></div>
          {market_shape_html}
          <div class="ladder-marker current" style="left:{current_left:.2f}%;"{current_tooltip}><span>Current</span></div>
          <div class="ladder-marker proposed" style="left:{proposed_left:.2f}%;"{proposed_tooltip}><span>Proposed</span></div>
          <div class="ladder-axis axis-min">{compact_currency(domain_min)}</div>
          <div class="ladder-axis axis-max">{compact_currency(domain_max)}</div>
        </div>
        <div class="pricing-ladder-meta muted">
          {market_stats_html}
        </div>
      </div>
    """


def render_market_price_table(row: dict) -> str:
    if not row["pricingEvidenceSourceDetails"]:
        return """
    <table class="market-table">
      <thead>
        <tr>
          <th>Post-tax</th>
          <th>Match</th>
          <th>Product</th>
          <th>Brand</th>
          <th>Category</th>
          <th>Distance</th>
          <th>Dispensary</th>
          <th>Address</th>
          <th>Link</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td colspan="9" class="muted">No reliable same-brand, same-format Lit Alerts listings were selected for this row.</td>
        </tr>
      </tbody>
    </table>
    """

    rows_html = []
    for source in sorted(
        row["pricingEvidenceSourceDetails"],
        key=lambda value: (
            float(value["postTaxPrice"]),
            value.get("retailerDistanceMiles") if value.get("retailerDistanceMiles") is not None else 999.0,
            value.get("dispensaryName") or value.get("label") or "",
        ),
    ):
        match_label, match_class = source_match_badge(row, source)
        link_html = (
            f'<a href="{html.escape(source["url"])}" target="_blank" rel="noopener noreferrer">Open listing</a>'
            if source.get("url")
            else "-"
        )
        category_label = source.get("category") or "-"
        if source.get("subcategory"):
            category_label += f" / {source['subcategory']}"
        row_tooltip = tooltip_attr(
            [
                source.get("dispensaryName") or source.get("label") or "Competitor",
                f"Post-tax: {compact_currency(float(source['postTaxPrice']))}",
                f"Distance: {source.get('distanceLabel') or 'n/a'}",
                source.get("dispensaryAddress") or "",
                *source_metadata_lines(source),
            ]
        )
        rows_html.append(
            f"""
            <tr class="market-row {match_class}"{row_tooltip}>
              <td>{compact_currency(float(source['postTaxPrice']))}</td>
              <td><span class="match-chip {match_class}">{html.escape(match_label)}</span></td>
              <td>{html.escape(source_product_name(source))}</td>
              <td>{html.escape(source.get('brand') or '-')}</td>
              <td>{html.escape(category_label)}</td>
              <td>{html.escape(source.get('distanceLabel') or '-')}</td>
              <td>{html.escape(source.get('dispensaryName') or source.get('label') or '-')}</td>
              <td>{html.escape(source.get('dispensaryAddress') or '-')}</td>
              <td>{link_html}</td>
            </tr>
            """
        )
    return f"""
    <table class="market-table">
      <thead>
        <tr>
          <th>Post-tax</th>
          <th>Match</th>
          <th>Competitor product</th>
          <th>Brand</th>
          <th>Category</th>
          <th>Distance</th>
          <th>Dispensary</th>
          <th>Address</th>
          <th>Listing</th>
        </tr>
      </thead>
      <tbody>
        {''.join(rows_html)}
      </tbody>
    </table>
    """


def render_detail_page(row: dict) -> str:
    distributors = ", ".join(row["distributors"]) or "-"
    target_line = row["targetStrain"] or "-"
    if row["targetPrevalence"]:
        target_line += f" ({row['targetPrevalence']})"
    total_grams = grams_from_value(row.get("totalGrams")) or "-"
    per_unit_grams = grams_from_value(row.get("perUnitGrams")) or "-"
    attrs = []
    if row["proposedEffects"]:
        attrs.append(f"Effects: {', '.join(row['proposedEffects'])}")
    if row["proposedFlavors"]:
        attrs.append(f"Flavors: {', '.join(row['proposedFlavors'])}")
    if row["proposedTerpenes"]:
        attrs.append(f"Terpenes: {', '.join(row['proposedTerpenes'])}")
    attrs_html = "<br>".join(html.escape(part) for part in attrs) if attrs else '<span class="muted">No reviewed attribute set recorded yet.</span>'
    image_html = (
        f'<a class="thumb-link detail-thumb" href="{html.escape(row["imageUrl"])}" target="_blank" rel="noopener noreferrer">'
        f'<img src="{html.escape(row["imageUrl"])}" alt="{html.escape(row["productName"])} image"></a>'
        if row["imageUrl"]
        else '<div class="thumb-link thumb-empty detail-thumb">No image</div>'
    )
    pricing_flags = []
    if row.get("pricingBelowFloor"):
        pricing_flags.append(chip("below gm floor", "warning"))
    pricing_override_html = (
        f'<div class="pricing-note muted">{html.escape(row["pricingOverrideNote"])}</div>'
        if row.get("pricingOverrideNote")
        else ""
    )
    evidence_coverage = pricing_evidence_coverage_text(row)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{html.escape(row['productName'])} - Preroll Proposal Detail</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f2eee5;
      --card: #fffaf1;
      --ink: #1f1b17;
      --muted: #6d665b;
      --line: #d9ceb7;
      --keep: #1f5d42;
      --raise: #8a4626;
      --lower: #8d2f52;
      --catalog: #27417e;
      --source: #614478;
      --image: #916c1e;
      --warning: #8b5e11;
      --d050: #1ed760;
      --d100: #63d24a;
      --d200: #b6cb38;
      --d350: #d8bf3f;
      --d500: #e08b43;
      --d999: #df574d;
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }}
    a {{ color: inherit; }}
    .wrap {{ max-width: 1260px; margin: 0 auto; padding: 28px 24px 40px; }}
    .topbar {{ display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; }}
    .back-link {{ color: var(--muted); text-decoration: none; font-size: 14px; }}
    .hero {{ display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 22px; align-items: start; }}
    .hero-card, .section {{ background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 18px; box-shadow: 0 8px 24px rgba(31, 27, 23, 0.05); }}
    h1 {{ margin: 0 0 8px; font-size: 26px; line-height: 1.15; }}
    h2 {{ margin: 0 0 12px; font-size: 17px; }}
    .meta {{ color: var(--muted); font-size: 14px; line-height: 1.5; }}
    .chip {{ display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #fff; margin: 0 6px 6px 0; }}
    .chip.keep {{ background: var(--keep); }}
    .chip.raise {{ background: var(--raise); }}
    .chip.lower {{ background: var(--lower); }}
    .chip.catalog {{ background: var(--catalog); }}
    .chip.source {{ background: var(--source); }}
    .chip.image {{ background: var(--image); }}
    .chip.warning {{ background: var(--warning); }}
    .muted {{ color: var(--muted); }}
    .metric {{ font-weight: 600; }}
    .metric-detail {{ font-weight: 400; }}
    .thumb-link, .thumb-empty {{ display: inline-flex; width: 100%; aspect-ratio: 1 / 1; align-items: center; justify-content: center; border-radius: 16px; border: 1px solid var(--line); overflow: hidden; background: #f8f1e5; }}
    .thumb-link img {{ width: 100%; height: 100%; object-fit: cover; }}
    .detail-thumb {{ max-width: 240px; }}
    .section-grid {{ display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.9fr); gap: 18px; margin-top: 18px; }}
    .detail-grid {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; }}
    .detail-grid div {{ font-size: 14px; line-height: 1.5; }}
    .pricing-ladder-shell {{ margin-top: 6px; }}
    .pricing-ladder-shell.is-detail {{ margin-top: 12px; }}
    .pricing-ladder-head {{ display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; margin-bottom: 12px; }}
    .pricing-ladder {{ position: relative; height: 96px; margin: 6px 0 8px; }}
    .pricing-ladder.is-detail {{ height: 172px; margin: 10px 0 12px; }}
    .ladder-track {{ position: absolute; left: 0; right: 0; top: 34px; height: 4px; border-radius: 999px; background: #d9ceb7; }}
    .pricing-ladder.is-detail .ladder-track {{ top: 88px; }}
    .ladder-iqr {{ position: absolute; top: 28px; height: 16px; border-radius: 999px; background: rgba(39, 65, 126, 0.18); border: 1px solid rgba(39, 65, 126, 0.26); }}
    .pricing-ladder.is-detail .ladder-iqr {{ top: 80px; }}
    .ladder-median {{ position: absolute; top: 22px; width: 2px; height: 28px; background: #27417e; }}
    .pricing-ladder.is-detail .ladder-median {{ top: 74px; height: 32px; }}
    .ladder-competitor {{ position: absolute; width: 10px; height: 10px; margin-left: -5px; border-radius: 999px; border: 1px solid rgba(31, 27, 23, 0.25); box-shadow: 0 0 0 2px rgba(255, 250, 241, 0.85); }}
    .ladder-competitor.d050 {{ background: var(--d050); }}
    .ladder-competitor.d100 {{ background: var(--d100); }}
    .ladder-competitor.d200 {{ background: var(--d200); }}
    .ladder-competitor.d350 {{ background: var(--d350); }}
    .ladder-competitor.d500 {{ background: var(--d500); }}
    .ladder-competitor.d999, .ladder-competitor.unknown {{ background: var(--d999); }}
    .ladder-marker {{ position: absolute; top: 44px; width: 2px; height: 24px; transform: translateX(-1px); }}
    .pricing-ladder.is-detail .ladder-marker.current,
    .pricing-ladder.is-detail .ladder-marker.proposed {{ top: 98px; height: 28px; }}
    .ladder-marker::before {{ content: ''; position: absolute; left: 50%; top: -12px; width: 12px; height: 12px; transform: translateX(-50%) rotate(45deg); border: 2px solid currentColor; background: var(--card); }}
    .ladder-marker span {{ position: absolute; top: 18px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 700; white-space: nowrap; background: rgba(255,250,241,0.92); padding: 1px 6px; border-radius: 999px; border: 1px solid currentColor; }}
    .pricing-ladder.is-detail .ladder-marker span {{ font-size: 12px; }}
    .ladder-marker.current {{ color: #6d665b; }}
    .ladder-marker.proposed {{ color: #8a4626; }}
    .ladder-marker.market-average {{ top: 12px; height: 18px; color: #27417e; }}
    .pricing-ladder.is-detail .ladder-marker.market-average {{ top: 16px; height: 54px; }}
    .ladder-marker.market-average::before {{ top: auto; bottom: -12px; }}
    .ladder-marker.market-average span {{ top: auto; bottom: 18px; }}
    .ladder-axis {{ position: absolute; bottom: 0; font-size: 11px; color: var(--muted); }}
    .ladder-axis.axis-min {{ left: 0; }}
    .ladder-axis.axis-max {{ right: 0; }}
    .pricing-ladder-meta {{ display: flex; flex-wrap: wrap; gap: 8px 12px; font-size: 12px; }}
    .pricing-note {{ margin-top: 8px; font-size: 12px; }}
    .match-chip {{ display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid transparent; }}
    .match-chip.match-exact {{ background: rgba(31, 93, 66, 0.12); color: #1f5d42; border-color: rgba(31, 93, 66, 0.3); }}
    .match-chip.match-family {{ background: rgba(39, 65, 126, 0.1); color: #27417e; border-color: rgba(39, 65, 126, 0.24); }}
    .match-chip.match-cultivar {{ background: rgba(97, 68, 120, 0.1); color: #614478; border-color: rgba(97, 68, 120, 0.24); }}
    .match-chip.match-equivalent {{ background: rgba(109, 102, 91, 0.1); color: #6d665b; border-color: rgba(109, 102, 91, 0.24); }}
    .market-table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
    .market-table th, .market-table td {{ padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }}
    .market-table th {{ font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }}
    .market-row.match-exact td {{ background: rgba(31, 93, 66, 0.04); }}
    @media (max-width: 960px) {{
      .hero {{ grid-template-columns: 1fr; }}
      .section-grid, .detail-grid {{ grid-template-columns: 1fr; }}
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <a class="back-link" href="../{OUTPUT_HTML_PATH.name}">Back to preroll packet</a>
      <span class="muted">Click market listing links for the original competitor pages.</span>
    </div>

    <section class="hero">
      <div class="hero-card">
        {image_html}
        <div class="muted" style="margin-top: 10px;">{html.escape(row['imageReason'])}</div>
      </div>
      <div class="hero-card">
        <h1>{html.escape(row['productName'])}</h1>
        <div class="meta">{html.escape(row['brand'])} - product {row['productId']} / group {row['groupId']}<br>Format lane: {html.escape(row['subcategory'])} - {html.escape(row['variantLabel'])}<br>Distributor(s): {html.escape(distributors)}</div>
        <div style="margin-top: 12px;">
          {chip(row['pricingAction'].replace('-', ' '), 'raise' if row['pricingAction'] == 'raise-price' else 'lower' if row['pricingAction'] == 'lower-price' else 'keep')}
          {chip(row['catalogAction'].replace('-', ' '), 'catalog')}
          {chip(row['sourceStatus'].replace('-', ' '), 'source')}
          {chip(row['imageAction'].replace('-', ' '), 'image')}
          {''.join(pricing_flags)}
        </div>
        {render_pricing_ladder(row, detail=True)}
        {pricing_override_html}
      </div>
    </section>

    <div class="section-grid">
      <section class="section">
        <h2>Pricing Context</h2>
        <div class="detail-grid">
          <div><span class="muted">Current</span><br><span class="metric">{compact_currency(float(row['currentPrice']))}</span> <span class="muted">({row['currentGmPercent']:.2f}% GM)</span></div>
          <div><span class="muted">Proposed</span><br><span class="metric">{compact_currency(float(row['proposedPrice']))}</span> <span class="muted">({row['proposedGmPercent']:.2f}% GM)</span></div>
          <div><span class="muted">Market avg</span><br><span class="metric">{compact_currency(float(row['averageCompetitorPostTaxPrice']))}</span></div>
          <div><span class="muted">Evidence coverage</span><br><span class="metric">{html.escape(evidence_coverage)}</span></div>
          <div><span class="muted">Effective cost</span><br><span class="metric">{compact_currency(float(row['effectiveCost']))}</span></div>
          <div><span class="muted">Pricing reason</span><br>{html.escape(row['pricingReason'])}</div>
        </div>
      </section>

      <section class="section">
        <h2>Catalog Context</h2>
        <div class="detail-grid">
          <div><span class="muted">Format lane</span><br><span class="metric">{html.escape(row['subcategory'])}</span></div>
          <div><span class="muted">Variant label</span><br><span class="metric">{html.escape(row['variantLabel'])}</span></div>
          <div><span class="muted">Pack / per unit</span><br><span class="metric">{row['packCount']} units @ {html.escape(per_unit_grams)}</span></div>
          <div><span class="muted">Total grams</span><br><span class="metric">{html.escape(total_grams)}</span></div>
          <div><span class="muted">Current strain</span><br><span class="metric">{html.escape(row['currentStrain'] or '-')}</span></div>
          <div><span class="muted">Target strain</span><br><span class="metric">{html.escape(target_line)}</span></div>
          <div><span class="muted">Catalog action</span><br>{html.escape(row['catalogReason'])}</div>
          <div><span class="muted">Source note</span><br>{html.escape(row['sourceNote'])}</div>
          <div style="grid-column: 1 / -1;"><span class="muted">Reviewed attributes</span><br>{attrs_html}</div>
        </div>
      </section>
    </div>

    <section class="section" style="margin-top: 18px;">
      <h2>Enumerated Market Prices</h2>
      <p class="muted">This view lists every selected nearby competitor price so duplicate-price stacks are readable even when the compact row ladder gets crowded.</p>
      {render_market_price_table(row)}
    </section>
  </div>
</body>
</html>
"""


def write_detail_pages(rows: list[dict]) -> None:
    OUTPUT_DETAIL_DIR.mkdir(exist_ok=True)
    for row in rows:
        (OUTPUT_DETAIL_DIR / f"{int(row['productId'])}.html").write_text(render_detail_page(row))


def variant_group_label(row: dict) -> str:
    return row.get("variantLabel") or row["size"]


def render_packet_row(row: dict) -> str:
    price_class = "keep"
    if row["pricingAction"] == "raise-price":
        price_class = "raise"
    elif row["pricingAction"] == "lower-price":
        price_class = "lower"
    price_chip = chip(row["pricingAction"].replace("-", " "), price_class)
    image_chip = chip(row["imageAction"].replace("-", " "), "image")
    catalog_chip = chip(row["catalogAction"].replace("-", " "), "catalog")
    source_chip = chip(row["sourceStatus"].replace("-", " "), "source")
    distributors = ", ".join(row["distributors"]) or "-"
    target_line = row["targetStrain"] or "-"
    if row["targetPrevalence"]:
        target_line += f" ({row['targetPrevalence']})"
    attrs = []
    if row["proposedEffects"]:
        attrs.append(f"Effects: {', '.join(row['proposedEffects'])}")
    if row["proposedFlavors"]:
        attrs.append(f"Flavors: {', '.join(row['proposedFlavors'])}")
    if row["proposedTerpenes"]:
        attrs.append(f"Terpenes: {', '.join(row['proposedTerpenes'])}")
    attrs_html = "<br>".join(html.escape(part) for part in attrs) if attrs else "<span class=\"muted\">No reviewed attribute set recorded yet.</span>"
    image_html = (
        f'<a class="thumb-link" href="{html.escape(row["imageUrl"])}" target="_blank" rel="noopener noreferrer">'
        f'<img src="{html.escape(row["imageUrl"])}" alt="{html.escape(row["productName"])} image"></a>'
        if row["imageUrl"]
        else '<div class="thumb-link thumb-empty">No image</div>'
    )
    pricing_override_html = (
        f'<div class="pricing-note muted">{html.escape(row["pricingOverrideNote"])}</div>'
        if row.get("pricingOverrideNote")
        else ""
    )
    pricing_flags = []
    if row.get("pricingBelowFloor"):
        pricing_flags.append(chip("below gm floor", "warning"))
    pricing_ladder_html = render_pricing_ladder(row)
    return f"""
            <tr class="product-row" data-detail-href="{html.escape(detail_page_href(row))}">
              <td>
                <strong>{html.escape(row['productName'])}</strong><br>
                <span class="muted">{html.escape(row['brand'])} - product {row['productId']} / group {row['groupId']}</span><br>
                <span class="muted">{html.escape(row['subcategory'])} - {html.escape(row['variantLabel'])}</span><br>
                <span class="muted">Distributor(s): {html.escape(distributors)}</span>
              </td>
              <td>
                {image_chip}<br>
                {image_html}
                <div class="muted">{html.escape(row['imageReason'])}</div>
              </td>
              <td>
                {price_chip}<br>
                {''.join(pricing_flags)}
                {pricing_ladder_html}
                {pricing_override_html}
              </td>
              <td>
                {catalog_chip} {source_chip}<br>
                <span class="metric">Current strain: {html.escape(row['currentStrain'] or '-')}</span><br>
                <span class="metric">Target strain: {html.escape(target_line)}</span><br>
                <span class="muted">{html.escape(row['catalogReason'])}</span>
              </td>
              <td>
                {attrs_html}<br>
                <span class="muted">{html.escape(row['sourceNote'])}</span>
              </td>
            </tr>
    """


def render_brand_table(rows: list[dict]) -> str:
    return f"""
      <table class="group-table">
        <colgroup>
          <col style="width: 22%;">
          <col style="width: 14%;">
          <col style="width: 30%;">
          <col style="width: 19%;">
          <col style="width: 15%;">
        </colgroup>
        <thead>
          <tr>
            <th>Product</th>
            <th>Picture</th>
            <th>Pricing</th>
            <th>Catalog</th>
            <th>Attribute Notes</th>
          </tr>
        </thead>
        <tbody>
          {''.join(render_packet_row(row) for row in rows)}
        </tbody>
      </table>
    """


def render_group_footer(label: str) -> str:
    return f"""
      <div class="group-footer">
        <button class="group-collapse-button" type="button">Collapse {html.escape(label)}</button>
      </div>
    """


def render_grouped_packet(rows: list[dict]) -> str:
    hierarchy: dict[str, dict[str, dict[str, dict[str, list[dict]]]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    )
    for row in rows:
        hierarchy[row["category"]][row["subcategory"]][variant_group_label(row)][row["brand"]].append(row)

    sections = []
    for category, subcategory_map in hierarchy.items():
        category_count = sum(
            len(brand_rows)
            for variant_map in subcategory_map.values()
            for brand_map in variant_map.values()
            for brand_rows in brand_map.values()
        )
        subcategory_sections = []
        for subcategory, variant_map in subcategory_map.items():
            subcategory_count = sum(
                len(brand_rows)
                for brand_map in variant_map.values()
                for brand_rows in brand_map.values()
            )
            variant_sections = []
            for variant_name, brand_map in variant_map.items():
                variant_count = sum(len(brand_rows) for brand_rows in brand_map.values())
                brand_sections = []
                for brand, brand_rows in brand_map.items():
                    brand_sections.append(
                        f"""
            <details class="group-block group-brand" open>
              <summary>
                <span class="group-kicker">Brand</span>
                <strong>{html.escape(brand)}</strong>
                <span class="group-count">{len(brand_rows)} product{'s' if len(brand_rows) != 1 else ''}</span>
              </summary>
              <div class="group-content">
                {render_brand_table(brand_rows)}
                {render_group_footer('Brand')}
              </div>
            </details>
                        """
                    )
                variant_sections.append(
                    f"""
          <details class="group-block group-variant" open>
            <summary>
              <span class="group-kicker">Variant name</span>
              <strong>{html.escape(variant_name)}</strong>
              <span class="group-count">{variant_count} product{'s' if variant_count != 1 else ''}</span>
            </summary>
            <div class="group-content">
              {''.join(brand_sections)}
              {render_group_footer('Variant')}
            </div>
          </details>
                    """
                )
            subcategory_sections.append(
                f"""
        <details class="group-block group-subcategory" open>
          <summary>
            <span class="group-kicker">Subcategory</span>
            <strong>{html.escape(subcategory)}</strong>
            <span class="group-count">{subcategory_count} product{'s' if subcategory_count != 1 else ''}</span>
          </summary>
          <div class="group-content">
            {''.join(variant_sections)}
            {render_group_footer('Subcategory')}
          </div>
        </details>
                """
            )
        sections.append(
            f"""
      <details class="group-block group-category" open>
        <summary>
          <span class="group-kicker">Category</span>
          <strong>{html.escape(category)}</strong>
          <span class="group-count">{category_count} product{'s' if category_count != 1 else ''}</span>
        </summary>
        <div class="group-content">
          {''.join(subcategory_sections)}
          {render_group_footer('Category')}
        </div>
      </details>
            """
        )
    return ''.join(sections)


def render_html(report: dict) -> None:
    sorted_rows = sorted(
        report["rows"],
        key=lambda row: (
            row["category"].lower(),
            row["subcategory"].lower(),
            variant_group_label(row).lower(),
            row["brand"].lower(),
            row["productName"].lower(),
            int(row["productId"]),
        ),
    )
    summary = report["summary"]
    write_detail_pages(sorted_rows)
    OUTPUT_HTML_PATH.write_text(
        f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{PACKET_TITLE}</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f2eee5;
      --card: #fffaf1;
      --ink: #1f1b17;
      --muted: #6d665b;
      --line: #d9ceb7;
      --keep: #1f5d42;
      --raise: #8a4626;
      --lower: #8d2f52;
      --catalog: #27417e;
      --source: #614478;
      --image: #916c1e;
      --warning: #8b5e11;
      --d050: #1ed760;
      --d100: #63d24a;
      --d200: #b6cb38;
      --d350: #d8bf3f;
      --d500: #e08b43;
      --d999: #df574d;
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; padding: 32px; font: 14px/1.5 Georgia, 'Iowan Old Style', serif; background: radial-gradient(circle at top, #f6eee0 0%, var(--bg) 65%); color: var(--ink); }}
    h1, h2 {{ margin: 0 0 12px; font-family: 'Palatino', 'Book Antiqua', serif; }}
    h1 {{ font-size: 18px; }}
    code {{ font-family: 'SFMono-Regular', 'Menlo', monospace; }}
    a {{ color: #294f94; }}
    .wrap {{ max-width: 1800px; margin: 0 auto; }}
    .hero {{ background: var(--card); border: 1px solid var(--line); border-radius: 20px; padding: 24px 28px; box-shadow: 0 18px 40px rgba(31, 27, 23, 0.08); }}
    .summary-toggle {{ margin-top: 14px; }}
    .summary-toggle summary {{ cursor: pointer; color: #294f94; font-weight: 600; }}
    .summary-toggle summary::marker {{ color: #294f94; }}
    .summary-inner {{ margin-top: 14px; }}
    .summary {{ display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }}
    .summary-card {{ background: rgba(255,255,255,0.7); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }}
    .summary-card strong {{ display: block; font-size: 22px; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 20px; background: var(--card); border: 1px solid var(--line); border-radius: 18px; overflow: hidden; }}
    th, td {{ border-bottom: 1px solid var(--line); padding: 16px; vertical-align: top; text-align: left; }}
    th {{ background: #efe3cf; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }}
    tr:last-child td {{ border-bottom: 0; }}
    .chip {{ display: inline-block; padding: 3px 8px; border-radius: 999px; color: white; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; margin: 0 6px 6px 0; }}
    .chip.keep {{ background: var(--keep); }}
    .chip.raise {{ background: var(--raise); }}
    .chip.lower {{ background: var(--lower); }}
    .chip.catalog {{ background: var(--catalog); }}
    .chip.source {{ background: var(--source); }}
    .chip.image {{ background: var(--image); }}
    .chip.warning {{ background: var(--warning); }}
    .muted {{ color: var(--muted); }}
    .metric {{ font-weight: 600; }}
    .metric-detail {{ font-weight: 400; }}
    .thumb-link, .thumb-empty {{ display: inline-flex; width: 116px; height: 116px; align-items: center; justify-content: center; border-radius: 14px; border: 1px solid var(--line); overflow: hidden; background: #f8f1e5; }}
    .thumb-link img {{ width: 100%; height: 100%; object-fit: cover; }}
    .thumb-empty {{ color: var(--muted); font-size: 12px; }}
    .pricing-ladder-shell {{ margin-top: 6px; }}
    .pricing-ladder-shell.is-detail {{ margin-top: 12px; }}
    .pricing-ladder-head {{ display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; margin-bottom: 12px; }}
    .pricing-ladder {{ position: relative; height: 96px; margin: 6px 0 8px; }}
    .pricing-ladder.is-detail {{ height: 172px; margin: 10px 0 12px; }}
    .ladder-track {{ position: absolute; left: 0; right: 0; top: 34px; height: 4px; border-radius: 999px; background: #d9ceb7; }}
    .pricing-ladder.is-detail .ladder-track {{ top: 88px; }}
    .ladder-iqr {{ position: absolute; top: 28px; height: 16px; border-radius: 999px; background: rgba(39, 65, 126, 0.18); border: 1px solid rgba(39, 65, 126, 0.26); }}
    .pricing-ladder.is-detail .ladder-iqr {{ top: 80px; }}
    .ladder-median {{ position: absolute; top: 22px; width: 2px; height: 28px; background: #27417e; }}
    .pricing-ladder.is-detail .ladder-median {{ top: 74px; height: 32px; }}
    .ladder-competitor {{ position: absolute; width: 10px; height: 10px; margin-left: -5px; border-radius: 999px; border: 1px solid rgba(31, 27, 23, 0.25); box-shadow: 0 0 0 2px rgba(255, 250, 241, 0.85); }}
    .ladder-competitor.d050 {{ background: var(--d050); }}
    .ladder-competitor.d100 {{ background: var(--d100); }}
    .ladder-competitor.d200 {{ background: var(--d200); }}
    .ladder-competitor.d350 {{ background: var(--d350); }}
    .ladder-competitor.d500 {{ background: var(--d500); }}
    .ladder-competitor.d999, .ladder-competitor.unknown {{ background: var(--d999); }}
    .ladder-marker {{ position: absolute; top: 44px; width: 2px; height: 24px; transform: translateX(-1px); }}
    .pricing-ladder.is-detail .ladder-marker.current, .pricing-ladder.is-detail .ladder-marker.proposed {{ top: 98px; height: 28px; }}
    .ladder-marker::before {{ content: ''; position: absolute; left: 50%; top: -12px; width: 12px; height: 12px; transform: translateX(-50%) rotate(45deg); border: 2px solid currentColor; background: var(--card); }}
    .ladder-marker span {{ position: absolute; top: 18px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 700; white-space: nowrap; background: rgba(255,250,241,0.92); padding: 1px 6px; border-radius: 999px; border: 1px solid currentColor; }}
    .pricing-ladder.is-detail .ladder-marker span {{ font-size: 12px; }}
    .ladder-marker.current {{ color: #6d665b; }}
    .ladder-marker.proposed {{ color: #8a4626; }}
    .ladder-marker.market-average {{ top: 12px; height: 18px; color: #27417e; }}
    .pricing-ladder.is-detail .ladder-marker.market-average {{ top: 16px; height: 54px; }}
    .ladder-marker.market-average::before {{ top: auto; bottom: -12px; }}
    .ladder-marker.market-average span {{ top: auto; bottom: 18px; }}
    .ladder-axis {{ position: absolute; bottom: 0; font-size: 11px; color: var(--muted); }}
    .ladder-axis.axis-min {{ left: 0; }}
    .ladder-axis.axis-max {{ right: 0; }}
    .pricing-ladder-meta {{ display: flex; flex-wrap: wrap; gap: 8px 12px; font-size: 12px; }}
    .pricing-note {{ margin-top: 8px; font-size: 12px; }}
    .packet-groups {{ display: grid; gap: 12px; }}
    .group-block {{ background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 8px 24px rgba(31, 27, 23, 0.04); }}
    .group-block summary {{ display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; cursor: pointer; list-style: none; padding: 14px 18px; }}
    .group-block summary::-webkit-details-marker {{ display: none; }}
    .group-kicker {{ font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 700; }}
    .group-count {{ margin-left: auto; color: var(--muted); font-size: 12px; }}
    .group-content {{ padding: 0 12px 12px; }}
    .group-footer {{ display: flex; justify-content: flex-end; padding: 8px 6px 2px; }}
    .group-collapse-button {{ border: 1px solid var(--line); background: rgba(255,255,255,0.85); color: #294f94; border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer; }}
    .group-collapse-button:hover {{ background: rgba(41,79,148,0.08); }}
    .group-category > summary {{ background: rgba(39, 65, 126, 0.06); border-radius: 16px; }}
    .group-subcategory {{ margin-top: 10px; }}
    .group-subcategory > summary {{ background: rgba(97, 68, 120, 0.05); border-radius: 14px; }}
    .group-variant {{ margin-top: 10px; }}
    .group-variant > summary {{ background: rgba(145, 108, 30, 0.05); border-radius: 14px; }}
    .group-brand {{ margin-top: 10px; }}
    .group-brand > summary {{ background: rgba(31, 93, 66, 0.05); border-radius: 14px; }}
    .group-table {{ width: 100%; border-collapse: collapse; background: transparent; }}
    .product-row {{ cursor: pointer; }}
    .product-row:hover td {{ background: rgba(145, 108, 30, 0.05); }}
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1>{PACKET_TITLE}</h1>
      <details class="summary-toggle">
        <summary>Show packet summary</summary>
        <div class="summary-inner">
          <p class="muted">Combined proposal packet for the filtered live catalog subset: category <strong>{html.escape(TARGET_CATEGORY_NAME)}</strong>, the live preroll subcategories captured by Sweed, and nonzero distributor cost. Pricing families stay segmented by preroll format lane, pack count, per-stick size, infusion status, and blunt status so singles, multipacks, infused prerolls, and blunts are not mixed together. Pricing uses the workspace formula <code>GM% = 1 - 1.13 * cost / price</code>, targets roughly <strong>55%-65%</strong> GM when market data allows it, and otherwise aims a few percent below the observed competitor post-tax market on <strong>.00 / .50</strong> pricing. The pricing column uses a compact post-tax price ladder with hover tooltips on competitor points, concise distance cues like <code>0.22mi</code>, and explicit markers for our current, proposed, and market-average prices.</p>
          <p class="muted">Products are grouped by <strong>Category</strong> → <strong>Subcategory</strong> → <strong>Variant name</strong> → <strong>Brand</strong>, and each layer can be collapsed independently.</p>
          <p class="muted">Click any non-link part of a row to open that product's detail page in a new tab with a larger ladder and the full market-price list.</p>
          <div class="summary">
            <div class="summary-card"><span class="muted">Rows</span><strong>{summary['rowCount']}</strong></div>
            <div class="summary-card"><span class="muted">Price Raises</span><strong>{summary['priceActionCounts'].get('raise-price', 0)}</strong></div>
            <div class="summary-card"><span class="muted">Price Lowers</span><strong>{summary['priceActionCounts'].get('lower-price', 0)}</strong></div>
            <div class="summary-card"><span class="muted">Image Coverage</span><strong>{summary['imageActionCounts'].get('keep-current-image', 0)} / {summary['rowCount']}</strong></div>
            <div class="summary-card"><span class="muted">State Context</span><strong>{html.escape(report['stateContext']['dealerName'])}</strong></div>
          </div>
          {render_group_footer('Summary')}
        </div>
      </details>
    </section>
    <section class="packet-groups">
      {render_grouped_packet(sorted_rows)}
    </section>
  </div>
  <script>
    const nextCollapsibleAfter = (currentDetails) => {{
      const allDetails = Array.from(document.querySelectorAll('details'));
      const currentIndex = allDetails.indexOf(currentDetails);
      if (currentIndex === -1) {{
        return null;
      }}
      for (let index = currentIndex + 1; index < allDetails.length; index += 1) {{
        const candidate = allDetails[index];
        if (!currentDetails.contains(candidate)) {{
          return candidate;
        }}
      }}
      return null;
    }};

    document.querySelectorAll('.group-collapse-button').forEach((button) => {{
      button.addEventListener('click', (event) => {{
        event.stopPropagation();
        const details = button.closest('details');
        if (details) {{
          const targetTop = button.getBoundingClientRect().top;
          const nextDetails = nextCollapsibleAfter(details);
          details.open = false;
          requestAnimationFrame(() => {{
            const anchor = nextDetails || details;
            const anchorTop = anchor.getBoundingClientRect().top;
            window.scrollBy(0, anchorTop - targetTop);
          }});
        }}
      }});
    }});
    document.querySelectorAll('.product-row').forEach((row) => {{
      row.addEventListener('click', (event) => {{
        if (event.target.closest('a')) {{
          return;
        }}
        const selection = window.getSelection && window.getSelection();
        if (selection && selection.toString()) {{
          return;
        }}
        const href = row.dataset.detailHref;
        if (href) {{
          window.open(href, '_blank', 'noopener');
        }}
      }});
    }});
  </script>
</body>
</html>
"""
    )


def render_report(report: dict) -> None:
    rows = report.get("rows")
    if not isinstance(rows, list):
        raise RuntimeError("Snapshot payload is missing rows[]")
    OUTPUT_JSON_PATH.write_text(json.dumps(report, indent=2) + "\n")
    write_csv(rows)
    render_html(report)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate or re-render the prerolls pricing/catalog proposal packet."
    )
    parser.add_argument(
        "--render-from-json",
        type=Path,
        help="Re-render the official outputs from an existing frozen proposal JSON instead of querying live sources.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.render_from_json:
        progress(f"Re-rendering outputs from {args.render_from_json.name}")
        report = json.loads(args.render_from_json.read_text())
        render_report(report)
        progress("Re-render complete")
        return

    progress("Loading live preroll subset")
    request_params, source_rows = read_latest_subset()
    if not source_rows:
        raise RuntimeError("No live preroll rows matched the filtered catalog subset")
    progress(f"Loaded {len(source_rows)} live preroll rows")
    search_terms = build_competitor_search_terms(source_rows)
    progress(f"Built {len(search_terms)} Lit Alerts search terms")
    retailer_sets = fetch_provider_retailer_sets()
    provider_market = fetch_provider_market_data(retailer_sets, search_terms)
    progress("Finished Lit Alerts market fetch")
    pricing_evidence_by_family = build_family_pricing_evidence(source_rows, provider_market)
    progress(f"Built pricing evidence for {len(pricing_evidence_by_family)} preroll families")
    strains_by_name, state_context = fetch_all_strains()
    progress(f"Loaded {len(strains_by_name)} strain rows from Sweed")
    group_details = fetch_group_details([int(row["productGroup"]["id"]) for row in source_rows])
    progress(f"Loaded {len(group_details)} product-group detail rows")

    proposal_rows = []
    for index, row in enumerate(source_rows, start=1):
        group_id = int(row["productGroup"]["id"])
        pricing = build_price_proposal(row, pricing_evidence_by_family)
        catalog = build_catalog_proposal(row, strains_by_name)
        image = build_image_proposal(group_details[group_id])
        proposal_rows.append(flatten_row(row, catalog, pricing, image))
        if index == 1 or index % 50 == 0 or index == len(source_rows):
            progress(f"Proposal row assembly: {index}/{len(source_rows)}")

    proposal_rows.sort(key=export_sort_key)

    summary = {
        "rowCount": len(proposal_rows),
        "priceActionCounts": dict(Counter(row["pricingAction"] for row in proposal_rows)),
        "catalogActionCounts": dict(Counter(row["catalogAction"] for row in proposal_rows)),
        "sourceStatusCounts": dict(Counter(row["sourceStatus"] for row in proposal_rows)),
        "imageActionCounts": dict(Counter(row["imageAction"] for row in proposal_rows)),
    }

    report = {
        "generatedAt": now_iso(),
        "sourceHar": SOURCE_HAR_PATH.name,
        "requestParams": request_params,
        "stateContext": state_context,
        "competitorMarketData": {
            "primarySource": "Lit Alerts nearby competitor menu provider",
            "excludedRetailerNameCues": list(EXCLUDED_COMPETITOR_RETAILER_NAME_CUES),
            "referenceAddress": f"{REFERENCE_ADDRESS_LABEL}, {REFERENCE_ADDRESS_CITY}",
            "referenceCoordinates": {
                "latitude": REFERENCE_ADDRESS_LATITUDE,
                "longitude": REFERENCE_ADDRESS_LONGITUDE,
            },
            "retailerDiscoveryHar": retailer_sets["sourceHar"],
            "retailerDiscoveryRequestTemplate": retailer_sets["requestTemplate"],
            "retailerDiscoveryRadiusMiles": list(COMPETITOR_PROVIDER_RADIUS_STEPS),
            "providerHar": provider_market["sourceHar"],
            "providerRequestFilters": provider_market["requestFilters"],
            "providerSearchTerms": provider_market["searchTerms"],
            "providerRadiusSummaries": [
                {
                    "radiusMiles": radius_market["radiusMiles"],
                    "retailerCount": radius_market["retailerCount"],
                    "pagesFetched": radius_market["pagesFetched"],
                    "rawListingCount": radius_market["rawListingCount"],
                    "matchingListingCount": radius_market["matchingListingCount"],
                    "dispensaryIds": radius_market["dispensaryIds"],
                }
                for radius_market in provider_market["radiusMarkets"]
            ],
            "supplementPolicy": "No legacy public supplement is configured for this scope; every row must be backed by nearby Lit Alerts evidence captured during this run.",
        },
        "pricingRules": {
            "gmFormula": "GM% = 1 - 1.13 * cost / price",
            "targetMinPercent": TARGET_MIN_GM_PERCENT,
            "targetMaxPercent": TARGET_MAX_GM_PERCENT,
            "absoluteMinPercent": ABSOLUTE_MIN_GM_PERCENT,
            "postTaxMultiplier": POST_TAX_MULTIPLIER,
            "competitorDiscountFactor": COMPETITOR_PRICE_DISCOUNT_FACTOR,
            "snapPolicy": ".00 and .50 only",
        },
        "summary": summary,
        "rows": proposal_rows,
    }

    progress("Rendering proposal outputs")
    render_report(report)
    progress("Preroll proposal generation complete")


if __name__ == "__main__":
    main()
