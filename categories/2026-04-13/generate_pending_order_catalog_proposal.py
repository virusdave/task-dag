#!/usr/bin/env python3

from __future__ import annotations

import argparse
import copy
import csv
import datetime as dt
import html
import importlib.util
import json
import math
import re
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from statistics import median

import sys


WORKDIR = Path(__file__).resolve().parent
AUTOMATION_ROOT = WORKDIR.parents[1]
BULK_ADDITIONS_DIR = AUTOMATION_ROOT / "bulk_additions" / "2026-04-10"
LATEST_LITALERTS_REQUEST_HAR_PATH = WORKDIR / "brands.litalerts.com_Products_menulistings_Archive [26-04-13 22-28-32].har"

if str(BULK_ADDITIONS_DIR) not in sys.path:
    sys.path.insert(0, str(BULK_ADDITIONS_DIR))

import apply_product_catalog_attribute_updates as sweed_attr  # noqa: E402


PREROLL_HELPER_PATH = BULK_ADDITIONS_DIR / "generate_prerolls_pricing_catalog_proposal.py"
ORDER_LIST_FROM_DATE = "2026-04-01"
ORDER_LIST_TO_DATE = "2026-10-11"
STATE_DEALER_ID = 210248
STATE_DEALER_NAME = "Freshly Baked NY"

SITE_CONFIGS = {
    "midtown": {
        "dealerId": 210705,
        "dealerName": "Freshly Baked NYC - Midtown",
        "siteLabel": "Midtown",
        "packetTitle": "Pending Order Catalog Proposal",
        "outputStem": "pending_order_catalog_proposal",
    },
    "bronx": {
        "dealerId": 210249,
        "dealerName": "Freshly Baked NYC - The Bronx",
        "siteLabel": "Bronx",
        "packetTitle": "Bronx Pending Order Catalog Proposal",
        "outputStem": "bronx_pending_order_catalog_proposal",
    },
}

SITE_KEY = "midtown"
SITE_DEALER_ID = SITE_CONFIGS[SITE_KEY]["dealerId"]
SITE_DEALER_NAME = SITE_CONFIGS[SITE_KEY]["dealerName"]
SITE_LABEL = SITE_CONFIGS[SITE_KEY]["siteLabel"]
PACKET_TITLE = SITE_CONFIGS[SITE_KEY]["packetTitle"]
OUTPUT_STEM = SITE_CONFIGS[SITE_KEY]["outputStem"]
OUTPUT_JSON_PATH = WORKDIR / f"{OUTPUT_STEM}.json"
OUTPUT_CSV_PATH = WORKDIR / f"{OUTPUT_STEM}.csv"
OUTPUT_HTML_PATH = WORKDIR / f"{OUTPUT_STEM}.html"
OUTPUT_DETAIL_DIR = WORKDIR / f"{OUTPUT_STEM}_details"

POST_TAX_MULTIPLIER = 1.13
COMPETITOR_PRICE_DISCOUNT_FACTOR = 0.97
COMPETITOR_PRICE_MAX_FACTOR = 0.98


def configure_runtime(site_key: str, output_stem: str | None = None) -> None:
    global SITE_KEY
    global SITE_DEALER_ID
    global SITE_DEALER_NAME
    global SITE_LABEL
    global PACKET_TITLE
    global OUTPUT_STEM
    global OUTPUT_JSON_PATH
    global OUTPUT_CSV_PATH
    global OUTPUT_HTML_PATH
    global OUTPUT_DETAIL_DIR

    site_config = SITE_CONFIGS[site_key]
    SITE_KEY = site_key
    SITE_DEALER_ID = int(site_config["dealerId"])
    SITE_DEALER_NAME = str(site_config["dealerName"])
    SITE_LABEL = str(site_config["siteLabel"])
    PACKET_TITLE = str(site_config["packetTitle"])
    OUTPUT_STEM = output_stem or str(site_config["outputStem"])
    OUTPUT_JSON_PATH = WORKDIR / f"{OUTPUT_STEM}.json"
    OUTPUT_CSV_PATH = WORKDIR / f"{OUTPUT_STEM}.csv"
    OUTPUT_HTML_PATH = WORKDIR / f"{OUTPUT_STEM}.html"
    OUTPUT_DETAIL_DIR = WORKDIR / f"{OUTPUT_STEM}_details"

CSV_HEADERS = [
    "Distributor Product ID",
    "Order IDs",
    "Position IDs",
    "Distributor Product Name",
    "Expected Category",
    "Expected Subcategory",
    "Target Brand",
    "Target Group Name",
    "Target Variant Name",
    "Target Variant Tab",
    "Target Strain",
    "Target Prevalence",
    "Proposed Action",
    "Action Type",
    "Reuse Product ID",
    "Reuse Product Name",
    "Anchor Product IDs",
    "Anchor Price",
    "Effective Unit Cost",
    "Proposed Global Price",
    "GM%",
    "Average Lit Alerts Price",
    "Lit Alerts Match Count",
    "Lit Alerts Strategy",
    "Lit Alerts Brand IDs",
    "Lit Alerts Source Samples",
    "Sample Like",
    "Primary Image Source",
    "Primary Image URL",
    "Review Flags",
    "Notes",
]

HTML_STYLE_BLOCK = """
    :root {
      color-scheme: light;
      --bg: #f2eee5;
      --card: #fffaf1;
      --ink: #1f1b17;
      --muted: #6d665b;
      --line: #d9ceb7;
      --catalog: #27417e;
      --mapping: #1f5d42;
      --evidence: #614478;
      --warning: #8b5e11;
      --danger: #8d2f52;
      --image: #916c1e;
      --neutral: #6d665b;
      --table-head: #efe3cf;
      --shadow: rgba(31, 27, 23, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      font: 14px/1.55 Georgia, 'Iowan Old Style', serif;
      background: radial-gradient(circle at top, #f6eee0 0%, var(--bg) 65%);
      color: var(--ink);
    }
    a { color: #294f94; }
    code { font-family: 'SFMono-Regular', 'Menlo', monospace; }
    .wrap { max-width: 1780px; margin: 0 auto; }
    .hero,
    .panel,
    .group-block {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 18px 40px var(--shadow);
    }
    .hero {
      padding: 0;
      overflow: hidden;
    }
    .hero-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      align-items: baseline;
      cursor: pointer;
      list-style: none;
      padding: 16px 18px;
    }
    .hero-summary::-webkit-details-marker { display: none; }
    .hero-content { padding: 0 28px 24px; }
    h1,
    h2,
    h3 { margin: 0 0 10px; font-family: 'Palatino', 'Book Antiqua', serif; }
    h1 { font-size: 16pt; }
    h2 { font-size: 17px; }
    h3 { font-size: 15px; }
    .muted { color: var(--muted); }
    .summary-grid,
    .audit-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .summary-card,
    .audit-card {
      background: rgba(255,255,255,0.68);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px 16px;
    }
    .summary-card strong,
    .audit-card strong { display: block; font-size: 24px; }
    .banner-row {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.9fr);
      gap: 16px;
      margin-top: 18px;
    }
    .callout {
      border: 1px solid rgba(139, 94, 17, 0.25);
      background: rgba(139, 94, 17, 0.08);
      border-radius: 16px;
      padding: 16px 18px;
    }
    .callout.danger {
      border-color: rgba(141, 47, 82, 0.22);
      background: rgba(141, 47, 82, 0.07);
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #fff;
      margin: 0 6px 6px 0;
    }
    .chip.keep { background: var(--mapping); }
    .chip.raise { background: #8a4626; }
    .chip.lower { background: var(--danger); }
    .chip.catalog { background: var(--catalog); }
    .chip.mapping { background: var(--mapping); }
    .chip.evidence { background: var(--evidence); }
    .chip.warning { background: var(--warning); }
    .chip.danger { background: var(--danger); }
    .chip.image { background: var(--image); }
    .chip.neutral { background: var(--neutral); }
    .orders-panel,
    .packet-groups { margin-top: 20px; }
    .panel { padding: 20px 22px; }
    .orders-table,
    .group-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      background: transparent;
    }
    .orders-table th,
    .orders-table td,
    .group-table th,
    .group-table td {
      border-bottom: 1px solid var(--line);
      padding: 14px 12px;
      vertical-align: top;
      text-align: left;
    }
    .orders-table th,
    .group-table th {
      background: var(--table-head);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .orders-table tr:last-child td,
    .group-table tr:last-child td { border-bottom: 0; }
    .packet-groups { display: grid; gap: 12px; }
    .group-block summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      align-items: baseline;
      cursor: pointer;
      list-style: none;
      padding: 16px 18px;
    }
    .group-block summary::-webkit-details-marker { display: none; }
    .group-kicker {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      font-weight: 700;
    }
    .group-count {
      margin-left: auto;
      color: var(--muted);
      font-size: 12px;
    }
    .group-content { padding: 0 12px 12px; }
    .group-category > summary { background: rgba(39, 65, 126, 0.06); border-radius: 20px; }
    .group-subcategory { margin-top: 10px; }
    .group-subcategory > summary { background: rgba(97, 68, 120, 0.05); border-radius: 16px; }
    .group-variant { margin-top: 10px; }
    .group-variant > summary { background: rgba(145, 108, 30, 0.05); border-radius: 16px; }
    .group-brand { margin-top: 10px; }
    .group-brand > summary { background: rgba(31, 93, 66, 0.05); border-radius: 16px; }
    .product-row { cursor: pointer; }
    .product-row:hover td { background: rgba(145, 108, 30, 0.05); }
    .meta-stack { display: grid; gap: 4px; }
    .metric { font-weight: 700; }
    .thumb-link,
    .thumb-empty {
      display: inline-flex;
      width: 118px;
      height: 118px;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      border: 1px solid var(--line);
      overflow: hidden;
      background: #f8f1e5;
      text-decoration: none;
    }
    .thumb-link img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .thumb-empty {
      color: var(--muted);
      font-size: 12px;
      text-align: center;
      padding: 10px;
    }
    .pricing-ladder-shell { margin-top: 6px; }
    .pricing-ladder-head {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      align-items: baseline;
      margin-bottom: 12px;
    }
    .metric-detail { font-weight: 400; }
    .pricing-ladder {
      position: relative;
      height: 96px;
      margin: 6px 0 8px;
    }
    .ladder-track {
      position: absolute;
      left: 0;
      right: 0;
      top: 34px;
      height: 4px;
      border-radius: 999px;
      background: #d9ceb7;
    }
    .ladder-iqr {
      position: absolute;
      top: 28px;
      height: 16px;
      border-radius: 999px;
      background: rgba(39, 65, 126, 0.18);
      border: 1px solid rgba(39, 65, 126, 0.26);
    }
    .ladder-median {
      position: absolute;
      top: 22px;
      width: 2px;
      height: 28px;
      background: #27417e;
    }
    .ladder-competitor {
      position: absolute;
      width: 10px;
      height: 10px;
      margin-left: -5px;
      border-radius: 999px;
      border: 1px solid rgba(31, 27, 23, 0.25);
      box-shadow: 0 0 0 2px rgba(255, 250, 241, 0.85);
      background: var(--evidence);
    }
    .ladder-competitor.statewide,
    .ladder-competitor.unknown { background: var(--evidence); }
    .ladder-marker {
      position: absolute;
      top: 44px;
      width: 2px;
      height: 24px;
      transform: translateX(-1px);
    }
    .ladder-marker::before {
      content: '';
      position: absolute;
      left: 50%;
      top: -12px;
      width: 12px;
      height: 12px;
      transform: translateX(-50%) rotate(45deg);
      border: 2px solid currentColor;
      background: var(--card);
    }
    .ladder-marker span {
      position: absolute;
      top: 18px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
      background: rgba(255,250,241,0.92);
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid currentColor;
    }
    .ladder-marker.current { color: #6d665b; }
    .ladder-marker.proposed { color: #8a4626; }
    .ladder-marker.market-average {
      top: 12px;
      height: 18px;
      color: #27417e;
    }
    .ladder-marker.market-average::before {
      top: auto;
      bottom: -12px;
    }
    .ladder-marker.market-average span {
      top: auto;
      bottom: 18px;
    }
    .ladder-axis {
      position: absolute;
      bottom: 0;
      font-size: 11px;
      color: var(--muted);
    }
    .ladder-axis.axis-min { left: 0; }
    .ladder-axis.axis-max { right: 0; }
    .pricing-ladder-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      font-size: 12px;
    }
    .pricing-note { margin-top: 8px; font-size: 12px; }
    .match-chip {
      display: inline-flex;
      align-items: center;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border: 1px solid transparent;
    }
    .match-chip.match-exact {
      background: rgba(31, 93, 66, 0.12);
      color: #1f5d42;
      border-color: rgba(31, 93, 66, 0.3);
    }
    .match-chip.match-family {
      background: rgba(39, 65, 126, 0.1);
      color: #27417e;
      border-color: rgba(39, 65, 126, 0.24);
    }
    .match-chip.match-cultivar {
      background: rgba(97, 68, 120, 0.1);
      color: #614478;
      border-color: rgba(97, 68, 120, 0.24);
    }
    .match-chip.match-equivalent {
      background: rgba(109, 102, 91, 0.1);
      color: #6d665b;
      border-color: rgba(109, 102, 91, 0.24);
    }
    .market-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      margin-top: 0;
    }
    .market-table th,
    .market-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    .market-table th {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      background: transparent;
    }
    .market-row.match-exact td { background: rgba(31, 93, 66, 0.04); }
    .source-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 10px;
      margin-top: 10px;
    }
    .source-card {
      display: grid;
      grid-template-columns: 76px minmax(0, 1fr);
      gap: 10px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255,255,255,0.7);
    }
    .source-thumb,
    .source-thumb.thumb-empty {
      width: 76px;
      height: 76px;
      border-radius: 12px;
    }
    .source-body { min-width: 0; }
    .source-title {
      font-weight: 700;
      margin-bottom: 2px;
      overflow-wrap: anywhere;
    }
    .source-price { font-weight: 700; color: var(--catalog); }
    .notes-list,
    .flag-list { margin: 8px 0 0; padding-left: 18px; }
    .notes-list li,
    .flag-list li { margin: 4px 0; }
    .empty-evidence {
      margin-top: 10px;
      padding: 12px 14px;
      border: 1px dashed rgba(139, 94, 17, 0.4);
      border-radius: 14px;
      background: rgba(139, 94, 17, 0.06);
    }
    .group-footer {
      display: flex;
      justify-content: flex-end;
      padding: 8px 6px 2px;
    }
    .group-collapse-button {
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.85);
      color: #294f94;
      border-radius: 999px;
      padding: 6px 12px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .group-collapse-button:hover { background: rgba(41,79,148,0.08); }
    @media (max-width: 1100px) {
      body { padding: 18px; }
      .banner-row { grid-template-columns: 1fr; }
      .group-table,
      .orders-table,
      .group-table thead,
      .orders-table thead,
      .group-table tbody,
      .orders-table tbody,
      .group-table tr,
      .orders-table tr,
      .group-table td,
      .orders-table td { display: block; width: 100%; }
      .group-table th,
      .orders-table th { display: none; }
      .group-table td,
      .orders-table td { padding: 12px 0; }
      .source-grid { grid-template-columns: 1fr; }
    }
"""

EXACT_REUSE_PRODUCT_IDS = {
    "Pr(Pre-Roll Pack)-Anthem-Indica Blend-10PK-3.5g-I": 338655,
    "SMACK Infused .5g Pre-Roll Blu Cookie Monster": 290165,
    "SMACK Infused 1g Pre-Roll Blu Cookie Monster": 290203,
    "SMACK Infused 1g Pre-Roll Cranberry Rozay": 290206,
    "SMACK Infused 1g Pre-Roll Twisted Lime Kush": 290159,
    "Camino - Sour Gummy - Blackberry Dream - 100mg THC - 10ct": 41793,
    "Camino - Sour Gummy - Raspberry Lemonade - 100mg THC - 10ct": 41802,
}

NAME_ALIASES = {
    "Happy Purp": "Happy Purps",
    "#JUAN-ROLL": "#Juan Roll",
    "Select Essentials": "Select",
}

GENERIC_PLACEHOLDER_PRODUCT_NAMES = {
    "edibles samples 10x 10mg",
    "preroll samples samples",
}

CURALEAF_CATEGORY_MAP = {
    "Pr(Pre-Roll)": ("Pre-Rolls", "Infused"),
    "Pr(Pre-Roll Pack)": ("Pre-Rolls", None),
    "F(Whole Flower)": ("Flower", "Pre-Packaged Flower"),
    "V(BRIQ)": ("Vapes", None),
}

PREVALENCE_MAP = {
    "I": "Indica",
    "S": "Sativa",
    "H": "Hybrid",
}

LITALERTS_CATEGORY_ID_BY_CATEGORY = {"Pre-Rolls": "2", "Vapes": "4"}

LITALERTS_BRAND_ALIASES = {
    "#Juan Roll": ("#Juan Roll", "Juan Roll"),
    "Anthem": ("Anthem", "Anthem (Curaleaf)"),
    "Bytes": ("Bytes",),
    "Cannabals": ("Cannabals",),
    "Camino": ("Camino",),
    "Grass Roots": ("Grass Roots", "Grassroots", "Grassroots (Curaleaf)"),
    "Ichi Roll": ("Ichi Roll",),
    "Chopsticks": ("Chopsticks", "Chopstix"),
    "Jenny's": ("Jenny's", "Jenny's Baked at Home", "Jenny's Baked at Home Company"),
    "Kiva": ("Kiva",),
    "LayUp": ("LayUp", "Lay Up"),
    "Lost Farm": ("Lost Farm",),
    "Moonlit Hash Co": ("Moonlit Hash Co", "Moonlit Hash", "Moonlit"),
    "O-YEAH!": ("O-YEAH!", "O-Yeah!", "O Yeah"),
    "Outrankd": ("Outrankd",),
    "Posh Puff": ("Posh Puff",),
    "Select": ("Select", "Select (Curaleaf)"),
    "Revert Cannabis": ("Revert Cannabis", "Revert"),
    "Smack": ("Smack",),
    "Smartbud": ("Smartbud", "Smart Bud"),
    "State of Mind": ("State of Mind",),
    "Sushi Hash": ("Sushi Hash",),
    "The Gram": ("The Gram",),
}

LITALERTS_CATEGORY_LABELS = {
    "Edibles": {"Edibles"},
    "Beverages": {"Beverages", "Tinctures"},
    "Flower": {"Flower"},
    "Pre-Rolls": {"Pre-Rolls"},
    "Vapes": {"Vaporizers", "Vapes"},
}

LITALERTS_PACK_COUNT_PATTERNS = (
    re.compile(r"\b(\d+)\s*x\b", re.IGNORECASE),
    re.compile(r"\b(\d+)\s*[- ]?(?:pk|pack|ct|count)\b", re.IGNORECASE),
)

LITALERTS_PACK_AND_UNIT_PATTERNS = (
    re.compile(r"\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(mg|g)\b", re.IGNORECASE),
    re.compile(r"\b(\d+)\s*[- ]?(?:pk|pack|ct|count)\s*[x-]?\s*(\d+(?:\.\d+)?)\s*(mg|g)\b", re.IGNORECASE),
    re.compile(r"\b(\d+)\s*[- ]?(?:pk|pack|ct|count)\b.*?\b(\d+(?:\.\d+)?)\s*(mg|g)\b", re.IGNORECASE),
    re.compile(r"\b(\d+(?:\.\d+)?)\s*(mg|g)\s*(\d+)\s*[- ]?(?:pk|pack|ct|count)\b", re.IGNORECASE),
)

LITALERTS_WEIGHT_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*(mg|g)\b", re.IGNORECASE)
LITALERTS_GENERIC_SUFFIXES = (" live resin", " rosin", " hash hole")

PENDING_PRICE_OVERRIDES = {
    "540500": {
        "proposedPrice": 49.0,
        "reason": "Reviewer override: Grass Roots Triple Stack 3.5g should draft at $49.00.",
    },
    "540497": {
        "proposedPrice": 21.5,
        "reason": "Reviewer override: Anthem Jet Fuel 1g must carry a candidate price, using a $21.50 draft aligned to the current statewide post-tax market cluster.",
    },
}


def load_helper_module(path: Path):
    spec = importlib.util.spec_from_file_location("pending_order_preroll_helper", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


preroll_helper = load_helper_module(PREROLL_HELPER_PATH)


def money(value: float | None) -> str:
    if value is None:
        return ""
    return f"{value:.2f}"


def money_or_dash(value: float | None) -> str:
    if value is None:
        return "-"
    return f"${money(value)}"


def compact_currency(value: float | None) -> str:
    if value is None:
        return "-"
    return f"${float(value):.2f}"


def round_down_to_quarter(value: float) -> float:
    return math.floor(value * 4) / 4.0


def round_down_to_half(value: float) -> float:
    return math.floor(value * 2) / 2.0


def round_up_to_half(value: float) -> float:
    return math.ceil(value * 2) / 2.0


def gm_percent(cost: float | None, price: float | None) -> float | None:
    if cost is None or price is None or price <= 0:
        return None
    return round((1 - POST_TAX_MULTIPLIER * cost / price) * 100, 2)


def minimum_gm_floor_price(cost: float) -> float:
    return math.ceil((POST_TAX_MULTIPLIER * cost / 0.45) * 4) / 4.0


def competitor_post_tax_price(average_competitor_price: float) -> float:
    return average_competitor_price * POST_TAX_MULTIPLIER


def competitor_target_price(average_competitor_price: float) -> float:
    return round_down_to_quarter(competitor_post_tax_price(average_competitor_price) * COMPETITOR_PRICE_DISCOUNT_FACTOR)


def competitor_max_price(average_competitor_price: float) -> float:
    return competitor_post_tax_price(average_competitor_price) * COMPETITOR_PRICE_MAX_FACTOR


def preferred_price_at_or_above(value: float) -> float:
    return round_up_to_half(value)


def highest_preferred_price_below(limit: float, minimum_price: float | None = None) -> float:
    half_price = round_down_to_half(limit - 1e-9)
    quarter_price = round_down_to_quarter(limit - 1e-9)
    if minimum_price is None or half_price >= minimum_price - 1e-9:
        return half_price
    if minimum_price is None or quarter_price >= minimum_price - 1e-9:
        return quarter_price
    return quarter_price


def recommended_row_price(
    cost: float | None,
    average_competitor_price: float | None,
    fallback_price: float | None,
) -> tuple[float | None, str]:
    if cost is None:
        if fallback_price is None and average_competitor_price is not None:
            return (
                highest_preferred_price_below(competitor_max_price(average_competitor_price)),
                "Cost unresolved; using the statewide post-tax market band as the draft price basis because no live family anchor exists.",
            )
        return fallback_price, "Cost unresolved; holding fallback price rather than pretending to enforce the GM floor."

    minimum_price = minimum_gm_floor_price(cost)
    if average_competitor_price is not None:
        competitor_post_tax = competitor_post_tax_price(average_competitor_price)
        competitor_target = competitor_target_price(average_competitor_price)
        competitor_ceiling = competitor_max_price(average_competitor_price)
        if competitor_target < minimum_price:
            forced_price = highest_preferred_price_below(competitor_ceiling)
            return (
                forced_price,
                (
                    f"Competitor pressure keeps the draft below the normal 55% GM floor. "
                    f"Lit Alerts average ${money(average_competitor_price)} pre-tax -> ${money(competitor_post_tax)} post-tax equivalent."
                ),
            )
        return highest_preferred_price_below(competitor_ceiling, minimum_price), ""

    if fallback_price is None:
        return preferred_price_at_or_above(minimum_price), ""
    return preferred_price_at_or_above(max(fallback_price, minimum_price)), ""


def normalize_text(text: str | None) -> str:
    lowered = (text or "").lower().replace("&", " and ")
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered)
    return " ".join(lowered.split())


def quantile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    if len(ordered) == 1:
        return round(ordered[0], 2)
    position = (len(ordered) - 1) * fraction
    lower_index = math.floor(position)
    upper_index = math.ceil(position)
    if lower_index == upper_index:
        return round(ordered[lower_index], 2)
    lower_value = ordered[lower_index]
    upper_value = ordered[upper_index]
    interpolated = lower_value + (upper_value - lower_value) * (position - lower_index)
    return round(interpolated, 2)


def source_product_name(source: dict) -> str:
    label = (source.get("listingName") or source.get("label") or "").strip()
    if not label:
        return "-"
    dispensary_name = (source.get("dispensaryName") or "").strip()
    prefix = f"{dispensary_name} - " if dispensary_name else ""
    if prefix and label.startswith(prefix):
        return label[len(prefix) :].strip() or label
    if " - " in label:
        return label.split(" - ", 1)[-1].strip() or label
    return label


def source_metadata_lines(source: dict) -> list[str]:
    lines = []
    if source.get("brand"):
        lines.append(f"Brand: {source['brand']}")
    category_label = source.get("category") or ""
    if source.get("subcategory"):
        category_label = f"{category_label} / {source['subcategory']}" if category_label else source["subcategory"]
    if category_label:
        lines.append(f"Category: {category_label}")
    if source.get("weight"):
        lines.append(f"Weight: {source['weight']}")
    if source.get("quantity") is not None:
        lines.append(f"Quantity: {source['quantity']}")
    return lines


def source_match_badge(row: dict, source: dict) -> tuple[str, str]:
    target_variant = normalize_text(row["targetVariantName"])
    target_group = normalize_text(row["targetGroupName"])
    competitor_name = normalize_text(source_product_name(source))
    if competitor_name and (competitor_name == target_variant or competitor_name in target_variant or target_variant in competitor_name):
        return "product match", "match-exact"
    if target_group and target_group in competitor_name:
        return "same-brand cultivar", "match-cultivar"
    if (row.get("pricingEvidenceStrategy") or "").startswith("statewide-brand"):
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
        return "No reliable same-brand, same-format Lit Alerts comparables"
    coverage = (
        f"{row['pricingEvidenceRetailerMatchCount']} stores / "
        f"{row['pricingEvidenceProviderMatchCount']} matches"
    )
    radius_miles = row.get("pricingEvidenceRadiusMiles")
    if radius_miles is not None:
        return f"{coverage} / {radius_miles:.1f}mi"
    return f"{coverage} / statewide"


def pricing_domain_bounds(values: list[float | None]) -> tuple[float | None, float | None]:
    filtered = [float(value) for value in values if value is not None]
    if not filtered:
        return None, None
    domain_min = min(filtered)
    domain_max = max(filtered)
    spread = domain_max - domain_min
    padding = max(1.0, spread * 0.15) if spread > 0 else max(1.0, domain_max * 0.1 if domain_max else 1.0)
    return round(max(0.0, domain_min - padding), 2), round(domain_max + padding, 2)


def classify_pricing_action(current_price: float | None, proposed_price: float | None) -> str:
    if proposed_price is None:
        return "needs-price"
    if current_price is None:
        return "keep-price"
    if proposed_price > current_price + 0.01:
        return "raise-price"
    if proposed_price < current_price - 0.01:
        return "lower-price"
    return "keep-price"


def pricing_action_chip(row: dict) -> str:
    action = row.get("pricingAction") or "keep-price"
    if action == "raise-price":
        return chip("raise price", "raise")
    if action == "lower-price":
        return chip("lower price", "lower")
    if action == "needs-price":
        return chip("needs price", "warning")
    return chip("keep price", "keep")


def render_pricing_ladder(row: dict, detail: bool = False) -> str:
    domain_min = row.get("pricingDomainMin")
    domain_max = row.get("pricingDomainMax")
    current_price = row.get("currentPrice")
    proposed_price = row.get("proposedPrice")
    market_average = row.get("averageCompetitorPostTaxPrice")
    q1 = row.get("competitorQ1PostTaxPrice")
    q3 = row.get("competitorQ3PostTaxPrice")
    median_value = row.get("competitorMedianPostTaxPrice")

    if domain_min is None or domain_max is None or proposed_price is None:
        return "<div class='muted'>Pricing ladder unavailable until this row has a draft price.</div>"

    competitor_marks = []
    stack_counts: dict[float, int] = defaultdict(int)
    stack_base = 28 if detail else 22
    stack_gap = 10 if detail else 8
    stack_levels = 8 if detail else 3
    for source in sorted(
        row.get("pricingEvidenceSourceDetails") or [],
        key=lambda value: (
            float(value["postTaxPrice"]),
            value.get("dispensaryName") or value.get("label") or "",
            value.get("listingName") or "",
        ),
    ):
        left = price_position_percent(float(source["postTaxPrice"]), float(domain_min), float(domain_max))
        price_key = round(float(source["postTaxPrice"]), 2)
        top_offset = stack_base + (stack_counts[price_key] % stack_levels) * stack_gap
        stack_counts[price_key] += 1
        tooltip = tooltip_attr(
            [
                source.get("dispensaryName") or source.get("label") or "Competitor",
                f"Post-tax: {compact_currency(float(source['postTaxPrice']))}",
                f"Distance: {source.get('distanceLabel') or 'statewide'}",
                *source_metadata_lines(source),
            ]
        )
        mark = (
            f'<a class="ladder-competitor {html.escape(source.get("distanceBucket") or "statewide")}" style="left:{left:.2f}%; top:{top_offset}px;"'
            f' href="{html.escape(source.get("url") or "#")}" target="_blank" rel="noopener noreferrer"{tooltip}></a>'
            if source.get("url")
            else f'<span class="ladder-competitor {html.escape(source.get("distanceBucket") or "statewide")}" style="left:{left:.2f}%; top:{top_offset}px;"{tooltip}></span>'
        )
        competitor_marks.append(mark)

    current_left = price_position_percent(float(current_price if current_price is not None else proposed_price), float(domain_min), float(domain_max))
    proposed_left = price_position_percent(float(proposed_price), float(domain_min), float(domain_max))
    market_average_left = price_position_percent(float(market_average if market_average is not None else proposed_price), float(domain_min), float(domain_max))

    current_tooltip = tooltip_attr(
        [
            f"Current basis: {compact_currency(current_price)}",
            f"Basis: {row.get('currentPriceBasis') or 'current'}",
            f"Current GM: {row['currentGmPercent']:.2f}%" if row.get("currentGmPercent") is not None else "Current GM unavailable",
            f"Cost: {compact_currency(row.get('effectiveUnitCost'))}",
        ]
    )
    proposed_tooltip = tooltip_attr(
        [
            f"Proposed price: {compact_currency(proposed_price)}",
            f"Proposed GM: {row['gmPercent']:.2f}%" if row.get("gmPercent") is not None else "Proposed GM unavailable",
            f"Cost: {compact_currency(row.get('effectiveUnitCost'))}",
        ]
    )
    market_average_tooltip = tooltip_attr(
        [
            f"Market average: {compact_currency(market_average)}" if market_average is not None else "Market average unavailable",
            "Post-tax average across the retained Lit Alerts statewide listings.",
        ]
    )

    if row.get("pricingEvidenceSourceDetails"):
        market_stats_html = (
            f"<span>Market avg {compact_currency(market_average)}</span>"
            f"<span>Median {compact_currency(median_value)}</span>"
            f"<span>IQR {compact_currency(q1)}-{compact_currency(q3)}</span>"
            f"<span>Range {compact_currency(row.get('competitorMinPostTaxPrice'))}-{compact_currency(row.get('competitorMaxPostTaxPrice'))}</span>"
            f"<span>{html.escape(pricing_evidence_coverage_text(row))}</span>"
        )
        market_shape_html = (
            f'<div class="ladder-iqr" style="left:{price_position_percent(float(q1), float(domain_min), float(domain_max)):.2f}%; width:{max(price_position_percent(float(q3), float(domain_min), float(domain_max)) - price_position_percent(float(q1), float(domain_min), float(domain_max)), 0.8):.2f}%;"></div>'
            f'<div class="ladder-median" style="left:{price_position_percent(float(median_value), float(domain_min), float(domain_max)):.2f}%;"></div>'
            f"{''.join(competitor_marks)}"
            f'<div class="ladder-marker market-average" style="left:{market_average_left:.2f}%;"{market_average_tooltip}><span>Market avg</span></div>'
        )
    else:
        market_stats_html = f"<span>{html.escape(pricing_evidence_coverage_text(row))}</span>"
        market_shape_html = (
            f'<div class="ladder-marker market-average" style="left:{market_average_left:.2f}%;"{market_average_tooltip}><span>Market avg</span></div>'
            if market_average is not None
            else ""
        )

    current_gm_text = f"{row['currentGmPercent']:.2f}% GM" if row.get("currentGmPercent") is not None else "GM unavailable"
    proposed_gm_text = f"{row['gmPercent']:.2f}% GM" if row.get("gmPercent") is not None else "GM unavailable"

    return f"""
      <div class="pricing-ladder-shell{' is-detail' if detail else ''}">
        <div class="pricing-ladder-head">
          <span class="metric">{compact_currency(current_price)} <span class="metric-detail">({current_gm_text})</span> -&gt; {compact_currency(proposed_price)}<span class="metric-detail"> ({proposed_gm_text})</span></span>
        </div>
        <div class="pricing-ladder{' is-detail' if detail else ''}">
          <div class="ladder-track"></div>
          {market_shape_html}
          <div class="ladder-marker current" style="left:{current_left:.2f}%;"{current_tooltip}><span>Current</span></div>
          <div class="ladder-marker proposed" style="left:{proposed_left:.2f}%;"{proposed_tooltip}><span>Proposed</span></div>
          <div class="ladder-axis axis-min">{compact_currency(domain_min)}</div>
          <div class="ladder-axis axis-max">{compact_currency(domain_max)}</div>
        </div>
        <div class="pricing-ladder-meta muted">{market_stats_html}</div>
      </div>
    """


def render_market_price_table(row: dict) -> str:
    if not row.get("pricingEvidenceSourceDetails"):
        return """
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
          <th>Listing</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td colspan="8" class="muted">No reliable same-brand, same-format Lit Alerts listings were selected for this row.</td>
        </tr>
      </tbody>
    </table>
    """

    rows_html = []
    for source in sorted(
        row["pricingEvidenceSourceDetails"],
        key=lambda value: (
            float(value["postTaxPrice"]),
            value.get("dispensaryName") or value.get("label") or "",
            value.get("listingName") or "",
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
        rows_html.append(
            f"""
            <tr class="market-row {match_class}">
              <td>{compact_currency(float(source['postTaxPrice']))}</td>
              <td><span class="match-chip {match_class}">{html.escape(match_label)}</span></td>
              <td>{html.escape(source_product_name(source))}</td>
              <td>{html.escape(source.get('brand') or '-')}</td>
              <td>{html.escape(category_label)}</td>
              <td>{html.escape(source.get('distanceLabel') or 'statewide')}</td>
              <td>{html.escape(source.get('dispensaryName') or source.get('label') or '-')}</td>
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
          <th>Listing</th>
        </tr>
      </thead>
      <tbody>
        {''.join(rows_html)}
      </tbody>
    </table>
    """


def compact_text(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def canonical_brand_aliases(brand_name: str) -> tuple[str, ...]:
    aliases = LITALERTS_BRAND_ALIASES.get(brand_name, (brand_name,))
    deduped: list[str] = []
    seen: set[str] = set()
    for alias in aliases:
        key = compact_text(alias)
        if key and key not in seen:
            seen.add(key)
            deduped.append(alias)
    return tuple(deduped)


@lru_cache(maxsize=None)
def strict_statewide_brand_ids_for_name(brand_name: str) -> tuple[int, ...]:
    alias_keys = {preroll_helper.normalized_brand_key(alias) for alias in canonical_brand_aliases(brand_name)}
    alias_keys.discard("")
    if not alias_keys:
        return ()

    target_key = preroll_helper.normalized_brand_key(brand_name)
    matches = []
    for row in preroll_helper.statewide_brand_rows():
        candidate_key = preroll_helper.normalized_brand_key(row.get("name") or "")
        if not candidate_key or candidate_key not in alias_keys:
            continue
        matches.append(
            (
                0 if candidate_key == target_key else 1,
                abs(len(candidate_key) - len(target_key)),
                len(candidate_key),
                int(row["id"]),
            )
        )

    matches.sort()
    return tuple(match[-1] for match in matches[:5])


@lru_cache(maxsize=1)
def pending_order_statewide_request_template() -> tuple[str, dict[str, str], dict]:
    if not LATEST_LITALERTS_REQUEST_HAR_PATH.exists():
        return preroll_helper.statewide_exact_request_template()

    payload = json.loads(LATEST_LITALERTS_REQUEST_HAR_PATH.read_text())
    entry = payload["log"]["entries"][0]
    return (
        entry["request"]["url"],
        preroll_helper.provider_headers_from_entry(entry),
        json.loads(entry["request"]["postData"]["text"]),
    )


def clean_litalerts_search_term(text: str) -> str:
    value = clean_cultivar(text).replace("|", " ")
    value = re.sub(r"\(\s*\d+(?:\.\d+)?\s*g\s*\)", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\s+", " ", value).strip(" -")
    return value


def search_term_variants(parsed: dict, brand_ids: tuple[int, ...]) -> tuple[str, ...]:
    variants: list[str] = []
    seen: set[str] = set()

    def add(term: str) -> None:
        cleaned = clean_litalerts_search_term(term)
        key = compact_text(cleaned)
        if not cleaned or not key or key in seen:
            return
        seen.add(key)
        variants.append(cleaned)

    add(parsed["searchTerm"])
    add(parsed["groupName"])

    current_terms = list(variants)
    for term in current_terms:
        lowered = term.lower()
        for suffix in LITALERTS_GENERIC_SUFFIXES:
            if lowered.endswith(suffix):
                add(term[: -len(suffix)].strip(" -"))
        if int(parsed["packCount"] or 1) > 1:
            add(f"{term} {parsed['packCount']}pk")

    if not brand_ids:
        base_terms = list(variants)
        for alias in canonical_brand_aliases(parsed["brand"]):
            for term in base_terms:
                add(f"{alias} {term}")

    return tuple(variants)


def parse_litalerts_pack_count(text: str) -> int:
    for pattern in LITALERTS_PACK_COUNT_PATTERNS:
        match = pattern.search(text)
        if match:
            return int(match.group(1))
    return 1


def parse_litalerts_pack_and_unit(text: str) -> tuple[int | None, float | None]:
    for index, pattern in enumerate(LITALERTS_PACK_AND_UNIT_PATTERNS):
        match = pattern.search(text)
        if not match:
            continue
        if index == len(LITALERTS_PACK_AND_UNIT_PATTERNS) - 1:
            unit_value = float(match.group(1))
            unit = match.group(2)
            pack_count = int(match.group(3))
        else:
            pack_count = int(match.group(1))
            unit_value = float(match.group(2))
            unit = match.group(3)
        if unit.lower() == "mg":
            unit_value /= 1_000
        return pack_count, round(unit_value, 3)
    return None, None


def litalerts_weight_candidates(*texts: str | None) -> set[float]:
    values: set[float] = set()
    for text in texts:
        normalized = (text or "").replace(",", "")
        for match in LITALERTS_WEIGHT_PATTERN.finditer(normalized):
            value = float(match.group(1))
            if match.group(2).lower() == "mg":
                value /= 1_000
            values.add(round(value, 3))
    return values


def listing_matches_preroll_format(parsed: dict, item_name: str, weight_text: str | None) -> bool:
    expected_pack_count = int(parsed["packCount"] or 1)
    expected_per_unit = preroll_helper.parse_weight_to_grams(parsed["size"])
    expected_total = (
        round(expected_pack_count * float(expected_per_unit), 3)
        if expected_per_unit is not None and expected_pack_count > 1
        else None
    )

    explicit_pack_count, explicit_unit_grams = parse_litalerts_pack_and_unit(item_name)
    observed_pack_count = explicit_pack_count or parse_litalerts_pack_count(item_name)
    if expected_pack_count > 1 and observed_pack_count not in {1, expected_pack_count}:
        return False
    if expected_pack_count == 1 and observed_pack_count > 1:
        return False

    weight_candidates = litalerts_weight_candidates(item_name, weight_text)
    config_grams = preroll_helper.parse_weight_to_grams(weight_text)
    if config_grams is not None:
        weight_candidates.add(round(float(config_grams), 3))
    if explicit_unit_grams is not None:
        weight_candidates.add(explicit_unit_grams)
        if explicit_pack_count and explicit_pack_count > 1:
            weight_candidates.add(round(explicit_pack_count * explicit_unit_grams, 3))

    if expected_per_unit is not None:
        tolerated_targets = [round(float(expected_per_unit), 3)]
        if expected_total is not None:
            tolerated_targets.append(expected_total)

        if not weight_candidates:
            return False

        if expected_pack_count > 1 and observed_pack_count == 1 and expected_total is not None:
            return any(abs(candidate - expected_total) <= 0.06 for candidate in weight_candidates)

        if not any(abs(candidate - target) <= 0.06 for candidate in weight_candidates for target in tolerated_targets):
            return False

    listing_is_infused = preroll_helper.detect_infused(item_name)
    target_is_infused = parsed["subcategory"] == "Infused"
    if target_is_infused and not listing_is_infused:
        return False
    if not target_is_infused and listing_is_infused:
        return False

    return True


def litalerts_category_matches(expected_category: str, item_category: str | None) -> bool:
    allowed = LITALERTS_CATEGORY_LABELS.get(expected_category, {expected_category})
    return (item_category or "") in allowed


def chip(label: str, class_name: str) -> str:
    return f'<span class="chip {class_name}">{html.escape(label)}</span>'


def group_footer(label: str) -> str:
    return (
        "<div class='group-footer'>"
        f"<button class='group-collapse-button' type='button'>Collapse {html.escape(label)}</button>"
        "</div>"
    )


def render_thumb(image_url: str, alt_text: str, href: str | None = None, class_name: str = "") -> str:
    classes = " ".join(part for part in ["thumb-link", class_name] if part)
    empty_classes = " ".join(part for part in ["thumb-empty", class_name] if part)
    if image_url:
        target_href = href or image_url
        return (
            f'<a class="{classes}" href="{html.escape(target_href)}" target="_blank" rel="noopener noreferrer">'
            f'<img src="{html.escape(image_url)}" alt="{html.escape(alt_text)}"></a>'
        )
    return f'<div class="{empty_classes}">No image</div>'


def choose_primary_image(reuse: dict | None, anchors: list[dict], lit_sources: list[dict]) -> dict:
    if reuse and reuse.get("imageUrl"):
        return {
            "url": reuse["imageUrl"],
            "href": reuse["imageUrl"],
            "source": "exact live reuse",
            "note": "Image comes from the exact live catalog variant already linked to this proposal row.",
        }

    anchor = next((row for row in anchors if row.get("imageUrl")), None)
    if anchor:
        return {
            "url": anchor["imageUrl"],
            "href": anchor["imageUrl"],
            "source": "live family anchor",
            "note": (
                f"Image reuses same-format live family anchor {anchor['productName']} (product {anchor['productId']}) for reviewer context."
            ),
        }

    lit_source = next((source for source in lit_sources if source.get("imageUrl")), None)
    if lit_source:
        return {
            "url": lit_source["imageUrl"],
            "href": lit_source.get("url") or lit_source["imageUrl"],
            "source": "lit alerts evidence",
            "note": (
                f"Image is from Lit Alerts statewide evidence via {lit_source.get('dispensaryName') or lit_source.get('label') or 'menu listing'}; click through to verify the source listing."
            ),
        }

    return {
        "url": "",
        "href": "",
        "source": "missing",
        "note": "No reusable live family image or Lit Alerts listing image is attached yet.",
    }


def review_flags_for_row(
    lit_sources: list[dict],
    proposed_price: float | None,
    anchors: list[dict],
    primary_image: dict,
) -> list[str]:
    flags: list[str] = []
    if not lit_sources:
        flags.append("No Lit Alerts evidence")
    elif len(lit_sources) < 3:
        flags.append("Thin Lit Alerts evidence")
    if proposed_price is None:
        flags.append("Needs manual price")
    if not anchors:
        flags.append("No live family anchor")
    if not primary_image.get("url"):
        flags.append("Needs image review")
    return flags


def meaningful_value(value) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, (int, float, bool)):
        return True
    if isinstance(value, list):
        return any(meaningful_value(item) for item in value)
    if isinstance(value, dict):
        return any(meaningful_value(item) for item in value.values())
    return True


def is_placeholder_suggestion_row(row: dict) -> bool:
    if not isinstance(row, dict):
        return False
    without_products = {key: value for key, value in row.items() if key != "products"}
    return not meaningful_value(without_products) and not meaningful_value(row.get("products"))


def switch_context(dealer_id: int, expected_name: str) -> None:
    response = sweed_attr.api_call("store.auth.dealer.set", {"dealerId": dealer_id})
    current_id = int(response["user"]["currentDealerId"])
    current_name = response["user"]["currentDealerName"]
    if current_id != dealer_id or current_name != expected_name:
        raise RuntimeError(
            f"Dealer switch failed: expected {dealer_id} / {expected_name}, got {current_id} / {current_name}"
        )


class CatalogCache:
    def __init__(self) -> None:
        self.product_cache: dict[int, dict] = {}
        self.group_cache: dict[int, dict] = {}
        self.search_cache: dict[str, list[dict]] = {}

    def search(self, query: str) -> list[dict]:
        key = query.strip().lower()
        if key not in self.search_cache:
            switch_context(STATE_DEALER_ID, STATE_DEALER_NAME)
            response = sweed_attr.api_call("store.product.list.short", {"page": 1, "pageSize": 100, "query": query})
            self.search_cache[key] = list(response.get("data") or [])
        return self.search_cache[key]

    def product(self, product_id: int) -> dict:
        if product_id not in self.product_cache:
            switch_context(STATE_DEALER_ID, STATE_DEALER_NAME)
            self.product_cache[product_id] = sweed_attr.api_call("store.product.get", {"id": str(product_id)})["product"]
        return self.product_cache[product_id]

    def group(self, group_id: int) -> dict:
        if group_id not in self.group_cache:
            switch_context(STATE_DEALER_ID, STATE_DEALER_NAME)
            self.group_cache[group_id] = sweed_attr.api_call("store.product.group.get", {"id": group_id})
        return self.group_cache[group_id]

    def summary(self, product_id: int) -> dict:
        product = self.product(product_id)
        group = self.group(int(product["productGroupId"]))
        return {
            "productId": product_id,
            "productName": product.get("name") or "",
            "groupId": int(product["productGroupId"]),
            "groupName": group.get("name") or "",
            "brand": (group.get("brand") or {}).get("name") or (product.get("brand") or {}).get("name") or "",
            "category": (group.get("category") or {}).get("name") or (product.get("category") or {}).get("name") or "",
            "subcategory": (group.get("subcategory") or {}).get("name") or (product.get("subcategory") or {}).get("name") or "",
            "size": (product.get("size") or {}).get("name") or "",
            "packCount": int(product.get("packOfSize") or 1),
            "tab": product.get("tab") or "",
            "price": float(product.get("price") or 0),
            "strain": (group.get("strain") or {}).get("name") or "",
            "imageUrl": ((group.get("images") or [{}])[0]).get("url") or "",
            "allowedSaleType": (product.get("allowedSaleType") or {}).get("name") or "Medical and recreational",
        }


cache = CatalogCache()


def clean_cultivar(text: str) -> str:
    value = (text or "").strip()
    value = re.sub(r"\s*\((?:I|S|H)\)\s*$", "", value)
    return NAME_ALIASES.get(value, value)


def format_grams(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".") + "g"


def derive_prevalence(text: str) -> str | None:
    match = re.search(r"\((I|S|H)\)\s*$", text.strip())
    if not match:
        return None
    return PREVALENCE_MAP.get(match.group(1))


def parse_hrbotanical_name(name: str) -> dict:
    raw = name.strip()
    cleaned = raw.replace("#JUAN-ROLL", "#Juan Roll").replace("Pre-roll", "Preroll")
    lowered = cleaned.lower()
    if cleaned.startswith("#Juan Roll"):
        brand = "#Juan Roll"
    elif cleaned.startswith("Revert "):
        brand = "Revert Cannabis"
    elif cleaned.startswith("Ichi Roll"):
        brand = "Ichi Roll"
    elif cleaned.startswith("Chopsticks") or cleaned.startswith("Chopstix"):
        brand = "Chopsticks"
    elif cleaned.startswith("O-Yeah"):
        brand = "O-YEAH!"
    elif cleaned.startswith("SMACK"):
        brand = "Smack"
    elif cleaned.startswith("STATE OF MIND") or cleaned.startswith("State of Mind"):
        brand = "State of Mind"
    elif cleaned.startswith("Sushi Hash"):
        brand = "Sushi Hash"
    else:
        raise RuntimeError(f"Unhandled HR botanical product name: {name}")

    prevalence = derive_prevalence(cleaned)
    is_infused = "uninfused" not in lowered and any(token in lowered for token in ("infused", "live resin", "rosin", "hash hole"))
    is_revert_gummy = cleaned.startswith("Revert Edible Gummy ")
    category = "Edibles" if is_revert_gummy else "Pre-Rolls"
    subcategory = "Chews/Gummies" if is_revert_gummy else ("Infused" if is_infused else "")

    pack_count = 1
    size = "100mg" if is_revert_gummy else "1g"
    if is_revert_gummy:
        size = "100mg"
    elif re.search(r"\b4\s*pk|4-pack|4pk\b", cleaned, re.IGNORECASE):
        pack_count = 4
        size = "1g"
    elif re.search(r"\b5[-\s]*pack|5pk\b", cleaned, re.IGNORECASE):
        pack_count = 5
        size = "0.5g"
    elif re.search(r"\b2\s*pack|2-pack\b", cleaned, re.IGNORECASE):
        pack_count = 2
        size = "0.5g"
    elif re.search(r"\.5g|0\.5g", cleaned, re.IGNORECASE):
        size = "0.5g"

    if "|" in cleaned:
        parts = [part.strip() for part in cleaned.split("|") if part.strip()]
        cultivar_source = parts[-1]
    elif is_revert_gummy:
        cultivar_source = re.sub(r"^Revert Edible Gummy\s+", "", cleaned, flags=re.IGNORECASE)
        cultivar_source = re.sub(r"\s+100mg$", "", cultivar_source, flags=re.IGNORECASE)
    elif brand == "Revert Cannabis" and "Ground Flower Pre Roll 2 Pack" in cleaned:
        cultivar_source = re.sub(
            r"^Revert Distillate Infused Ground Flower Pre Roll 2 Pack\s+",
            "",
            cleaned,
            flags=re.IGNORECASE,
        )
    elif brand == "Revert Cannabis" and "Pre Roll" in cleaned:
        cultivar_source = re.sub(r"^Revert Pre Roll\s+", "", cleaned, flags=re.IGNORECASE)
        cultivar_source = re.sub(r"\s+(?:\.5g|0\.5g)$", "", cultivar_source, flags=re.IGNORECASE)
    elif brand in {"#Juan Roll", "Ichi Roll"} and "-" in cleaned:
        cultivar_source = cleaned.split("-")[-1]
    elif brand == "Chopsticks":
        cultivar_source = re.sub(r"^.*?2-Pack\s+", "", cleaned, flags=re.IGNORECASE)
    elif brand == "O-YEAH!":
        cultivar_source = re.sub(r"^.*?\(2\.5g\)\s*", "", cleaned, flags=re.IGNORECASE)
    elif brand == "Smack":
        cultivar_source = re.sub(r"^.*?(?:Preroll|Pre-Roll)\s+", "", cleaned, flags=re.IGNORECASE)
    elif brand == "State of Mind" and "5-Pack" in cleaned:
        cultivar_source = re.sub(r"^.*?\(2\.5g\)\s*", "", cleaned, flags=re.IGNORECASE)
    elif brand == "Sushi Hash":
        cultivar_source = re.sub(r"^.*?(?:\(2\.5g\)|Single)\s*", "", cleaned, flags=re.IGNORECASE)
    elif "-" in cleaned:
        cultivar_source = cleaned.split("-")[-1]
    else:
        cultivar_source = cleaned.split()[-1]
    cultivar = clean_cultivar(cultivar_source)
    cultivar = re.sub(r"^\(?\d+(?:\.\d+)?g\)?\s+", "", cultivar, flags=re.IGNORECASE)
    cultivar = re.sub(r"^Pack\s+", "", cultivar, flags=re.IGNORECASE)
    cultivar = clean_cultivar(cultivar)

    tab = f"{pack_count}x {size}" if pack_count > 1 else size
    if is_revert_gummy:
        group_name = f"{cultivar} Gummy"
        variant_name = f"{brand} {group_name} {size}"
        strain_name = ""
    else:
        group_name = cultivar
        variant_name = f"{brand} {cultivar} {tab}" if pack_count > 1 else f"{brand} {cultivar} {size}"
        strain_name = cultivar

    return {
        "brand": brand,
        "category": category,
        "subcategory": subcategory,
        "groupName": group_name,
        "variantTab": tab,
        "variantName": variant_name,
        "size": size,
        "packCount": pack_count,
        "searchTerm": cultivar,
        "strainName": strain_name,
        "prevalence": prevalence,
    }


def parse_curaleaf_name(name: str) -> dict:
    match = re.match(r"^(Pr\(Pre-Roll(?: Pack)?\)|F\(Whole Flower\)|V\(BRIQ\))-(.+)$", name)
    if not match:
        raise RuntimeError(f"Unhandled Curaleaf product name: {name}")
    category_token = match.group(1)
    parts = [part.strip() for part in match.group(2).split("-") if part.strip()]
    if len(parts) < 3:
        raise RuntimeError(f"Unhandled Curaleaf product name: {name}")
    base_category, default_subcategory = CURALEAF_CATEGORY_MAP[category_token]
    brand_token = parts[0]
    modifier_tokens = parts[1:-2]
    size_token = parts[-2]
    prevalence_token = parts[-1]
    pack_token = next((token for token in modifier_tokens if re.fullmatch(r"\d+PK", token)), None)
    if pack_token:
        modifier_tokens = [token for token in modifier_tokens if token != pack_token]

    brand = {
        "Anthem": "Anthem",
        "Grassroots": "Grass Roots",
        "Select": "Select",
    }.get(brand_token, brand_token)

    if brand_token == "Anthem" and modifier_tokens and modifier_tokens[0] == "Bold":
        modifier_tokens = modifier_tokens[1:]
        default_subcategory = "Infused"
    if brand_token == "Grassroots" and modifier_tokens and modifier_tokens[0] == "Dark Heart":
        modifier_tokens = modifier_tokens[1:]
    if brand_token == "Select" and modifier_tokens and modifier_tokens[0] == "Essentials":
        modifier_tokens = modifier_tokens[1:]

    group_name = clean_cultivar("-".join(modifier_tokens).replace("Diamond Infused", "").replace("Glass Tip Infused", "").strip("- "))
    prevalence = PREVALENCE_MAP.get(prevalence_token)

    if base_category == "Pre-Rolls":
        pack_count = int(pack_token[:-2]) if pack_token else 1
        grams = float(size_token.replace("g", ""))
        if pack_count > 1:
            size = f"{grams / pack_count:.2f}".rstrip("0").rstrip(".") + "g"
        else:
            size = f"{grams:g}g"
        tab = f"{pack_count}x {size}" if pack_count > 1 else size
        variant_name = f"{brand} {group_name} {tab}" if pack_count > 1 else f"{brand} {group_name} {size}"
    elif base_category == "Vapes":
        size = size_token
        pack_count = 1
        tab = size
        variant_name = f"{brand} Essentials Briq {group_name} {size}" if brand == "Select" else f"{brand} {group_name} {size}"
        group_name = f"Essentials Briq {group_name}" if brand == "Select" else group_name
    else:
        size = size_token
        pack_count = 1
        tab = size
        variant_name = f"{brand} {group_name} {size}"

    subcategory = default_subcategory or ""
    return {
        "brand": brand,
        "category": base_category,
        "subcategory": subcategory,
        "groupName": group_name,
        "variantTab": tab,
        "variantName": variant_name,
        "size": size,
        "packCount": pack_count,
        "searchTerm": clean_cultivar(group_name.replace("Essentials Briq ", "")),
        "strainName": group_name,
        "prevalence": prevalence,
    }


def build_named_product(
    *,
    brand: str,
    category: str,
    subcategory: str,
    group_name: str,
    variant_name: str,
    size: str,
    pack_count: int,
    search_term: str,
    strain_name: str = "",
    prevalence: str | None = None,
    effect_names: list[str] | None = None,
    flavor_names: list[str] | None = None,
) -> dict:
    tab = f"{pack_count}x {size}" if pack_count > 1 else size
    return {
        "brand": brand,
        "category": category,
        "subcategory": subcategory,
        "groupName": group_name,
        "variantTab": tab,
        "variantName": variant_name,
        "size": size,
        "packCount": pack_count,
        "searchTerm": search_term,
        "strainName": strain_name,
        "prevalence": prevalence,
        "effectNames": effect_names or [],
        "flavorNames": flavor_names or [],
    }


CAMINO_NAME_MAP = {
    "camino - chews - boysenberry - 100mg thc - 10ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Sleep Boysenberry 2:1 (THC:CBN)",
        variant_name="Camino Sleep Boysenberry 2:1 (THC:CBN) 10x 10mg",
        size="10mg",
        pack_count=10,
        search_term="Boysenberry",
    ),
    "camino - chews - forest berry - 100mg thc - 10ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Energy Forest Berry 1:1 (THC:THCV)",
        variant_name="Camino Energy Forest Berry 1:1 (THC:THCV) 10x 10mg",
        size="10mg",
        pack_count=10,
        search_term="Forest Berry",
    ),
    "camino - chews - golden peach - 100mg thc - 10ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Recover Golden Peach 1:1 (THC:CBG)",
        variant_name="Camino Recover Golden Peach 1:1 (THC:CBG) 10x 10mg",
        size="10mg",
        pack_count=10,
        search_term="Golden Peach",
    ),
    "camino - chews - pineapple paradise - 100mg thc - 10ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Bliss Pineapple Paradise 1:1 (THC:CBC)",
        variant_name="Camino Bliss Pineapple Paradise 1:1 (THC:CBC) 10x 10mg",
        size="10mg",
        pack_count=10,
        search_term="Pineapple Paradise",
    ),
    "camino - gummy - freshly squeezed - 100mg thc - 20ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Recover Freshly Squeezed 1:2 (THC:CBG)",
        variant_name="Camino Recover Freshly Squeezed 1:2 (THC:CBG) 20x 5mg",
        size="5mg",
        pack_count=20,
        search_term="Freshly Squeezed",
    ),
    "camino - gummy - midnight blueberry - 100mg thc - 20ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Midnight Blueberry 5:1 (THC:CBN)",
        variant_name="Camino Midnight Blueberry 5:1 (THC:CBN) 20x 5mg",
        size="5mg",
        pack_count=20,
        search_term="Midnight Blueberry",
    ),
    "camino - gummy - pineapple habanero - 100mg thc - 20ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Uplifting Pineapple Habanero",
        variant_name="Camino Uplifting Pineapple Habanero 20x 5mg",
        size="5mg",
        pack_count=20,
        search_term="Pineapple Habanero",
    ),
    "camino - gummy - sparkling pear - 40mg thc - 120mg cbd - 20ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Social Sparkling Pear 1:3 (THC:CBD)",
        variant_name="Camino Social Sparkling Pear 1:3 (THC:CBD) 20x 2mg",
        size="2mg",
        pack_count=20,
        search_term="Sparkling Pear",
    ),
    "camino - gummy - watermelon lemonade - 100mg thc - 20ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Bliss Watermelon Lemonade",
        variant_name="Camino Bliss Watermelon Lemonade 20x 5mg",
        size="5mg",
        pack_count=20,
        search_term="Watermelon Lemonade",
    ),
    "camino - gummy - wild berry - 100mg thc - 20ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Chill Wild Berry",
        variant_name="Camino Chill Wild Berry 20x 5mg",
        size="5mg",
        pack_count=20,
        search_term="Wild Berry",
    ),
    "camino - gummy - wild cherry - 100mg thc/cbg/cbc - 20ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Excite Wild Cherry",
        variant_name="Camino Excite Wild Cherry 20x 5mg",
        size="5mg",
        pack_count=20,
        search_term="Wild Cherry",
    ),
    "camino - gummy - yuzu lemon - 100mg thc - 20ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Balance Yuzu Lemon 1:1 (THC:CBD)",
        variant_name="Camino Balance Yuzu Lemon 1:1 (THC:CBD) 20x 5mg",
        size="5mg",
        pack_count=20,
        search_term="Yuzu Lemon",
    ),
    "camino - sour gummy - blackberry dream - 100mg thc - 10ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Sours Deep Sleep Blackberry Dream 1:1:1 (THC:CBD:CBN)",
        variant_name="Camino Sours Deep Sleep Blackberry Dream 1:1:1 (THC:CBD:CBN) 10x 10mg",
        size="10mg",
        pack_count=10,
        search_term="Blackberry Dream",
    ),
    "camino - sour gummy - orchard peach - 100mg thc - 10ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Sours Balance Orchard Peach 1:1 (THC:CBD)",
        variant_name="Camino Sours Balance Orchard Peach 1:1 (THC:CBD) 10x 10mg",
        size="10mg",
        pack_count=10,
        search_term="Orchard Peach",
    ),
    "camino - sour gummy - raspberry lemonade - 100mg thc - 10ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Sours Bliss Raspberry Lemonade",
        variant_name="Camino Sours Bliss Raspberry Lemonade 10x 10mg",
        size="10mg",
        pack_count=10,
        search_term="Raspberry Lemonade",
    ),
    "camino - sour gummy - strawberry sunset - 100mg thc - 10ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Sours Chill Strawberry Sunset",
        variant_name="Camino Sours Chill Strawberry Sunset 10x 10mg",
        size="10mg",
        pack_count=10,
        search_term="Strawberry Sunset",
    ),
    "camino - sour gummy - tropical burst - 100mg thc - 10ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Sours Tropical Burst 2:1 (THC:THCV)",
        variant_name="Camino Sours Tropical Burst 2:1 (THC:THCV) 10x 10mg",
        size="10mg",
        pack_count=10,
        search_term="Tropical Burst",
    ),
    "camino - sour gummy - watermelon spritz - 100mg thc - 10ct": build_named_product(
        brand="Camino",
        category="Edibles",
        subcategory="",
        group_name="Sours Uplifting Watermelon Spritz",
        variant_name="Camino Sours Uplifting Watermelon Spritz 10x 10mg",
        size="10mg",
        pack_count=10,
        search_term="Watermelon Spritz",
    ),
}


def parse_camino_name(name: str) -> dict:
    parsed = CAMINO_NAME_MAP.get(name.strip().lower())
    if parsed:
        return dict(parsed)
    raise RuntimeError(f"Unhandled Camino product name: {name}")


def parse_kiva_name(name: str) -> dict:
    match = re.match(r"^KIVA\s*-\s*Chocolate Bar\s*-\s*Milk Chocolate Churro\s*-\s*100mg THC\s*$", name, re.IGNORECASE)
    if not match:
        raise RuntimeError(f"Unhandled Kiva product name: {name}")
    return build_named_product(
        brand="Kiva",
        category="Edibles",
        subcategory="Chocolate",
        group_name="Milk Churro Bar",
        variant_name="Kiva Milk Churro Bar 20x 5mg",
        size="5mg",
        pack_count=20,
        search_term="Milk Churro Bar",
    )


def parse_lost_farm_name(name: str) -> dict:
    match = re.match(
        r"^Lost Farm\s*-\s*Gummy\s*-\s*(.+?)\s+(Resin|Rosin)\s*-\s*100mg THC\s*-\s*(\d+)ct\s*$",
        name,
        re.IGNORECASE,
    )
    if not match:
        raise RuntimeError(f"Unhandled Lost Farm product name: {name}")

    pairing = clean_cultivar(match.group(1))
    infusion = f"Live {match.group(2).title()}"
    pack_count = int(match.group(3))
    if pack_count != 10:
        raise RuntimeError(f"Unhandled Lost Farm pack size in product name: {name}")
    size = "10mg"
    group_name = f"{infusion} {pairing}"
    return build_named_product(
        brand="Lost Farm",
        category="Edibles",
        subcategory="",
        group_name=group_name,
        variant_name=f"Lost Farm {group_name} 10x 10mg",
        size=size,
        pack_count=pack_count,
        search_term=pairing,
    )


def parse_bytes_name(name: str) -> dict:
    match = re.match(r"^Bytes\s*-\s*(.+?)\s*-\s*Edibles\s*-\s*(\d+)\s*$", name, re.IGNORECASE)
    if not match:
        raise RuntimeError(f"Unhandled Bytes product name: {name}")

    pack_count = int(match.group(2))
    if pack_count != 10:
        raise RuntimeError(f"Unhandled Bytes pack size in product name: {name}")

    cultivar = clean_cultivar(match.group(1))
    size = "10mg"
    tab = f"{pack_count}x {size}"
    return {
        "brand": "Bytes",
        "category": "Edibles",
        "subcategory": "Chews/Gummies",
        "groupName": cultivar,
        "variantTab": tab,
        "variantName": f"Bytes {cultivar} {tab}",
        "size": size,
        "packCount": pack_count,
        "searchTerm": cultivar,
        "strainName": "",
        "prevalence": None,
    }


def parse_cannabals_name(name: str) -> dict:
    vape_match = re.match(
        r"^Cannabals\s*-\s*Chubby Puff Vape\s*-\s*(.+?)\s*-\s*(\d+(?:\.\d+)?)g\s*$",
        name,
        re.IGNORECASE,
    )
    if vape_match:
        cultivar = clean_cultivar(vape_match.group(1))
        size = format_grams(float(vape_match.group(2)))
        group_name = f"Chubby Puff {cultivar}"
        return build_named_product(
            brand="Cannabals",
            category="Vapes",
            subcategory="All In One / Disposable",
            group_name=group_name,
            variant_name=f"Cannabals {group_name} {size}",
            size=size,
            pack_count=1,
            search_term=group_name,
            strain_name=cultivar,
        )

    gummy_match = re.match(
        r"^Cannabals\s*-\s*Gummy Brick\s*-(?:\s*Fast-Acting Distillate\s*-\s*1pk\s*-)?\s*(?:100\s*MG|100mg)\s*THC\s*-\s*(.+?)\s*$",
        name,
        re.IGNORECASE,
    )
    if gummy_match:
        flavor = clean_cultivar(gummy_match.group(1))
        group_name = f"{flavor} Gummy Brick"
        return build_named_product(
            brand="Cannabals",
            category="Edibles",
            subcategory="",
            group_name=group_name,
            variant_name=f"Cannabals {group_name} 10x 10mg",
            size="10mg",
            pack_count=10,
            search_term=group_name,
        )

    gummy_match = re.match(
        r"^Cannabals\s*-\s*Gummy Brick\s*-\s*(.+?)\s*-\s*(?:100\s*MG|100mg)\s*THC\s*$",
        name,
        re.IGNORECASE,
    )
    if gummy_match:
        flavor = clean_cultivar(gummy_match.group(1))
        group_name = f"{flavor} Gummy Brick"
        return build_named_product(
            brand="Cannabals",
            category="Edibles",
            subcategory="",
            group_name=group_name,
            variant_name=f"Cannabals {group_name} 10x 10mg",
            size="10mg",
            pack_count=10,
            search_term=group_name,
        )

    cones_match = re.match(
        r"^Cannabals\s*-\s*Cones\s*-\s*(.+?)\s*-\s*(?:10\s*MG|100mg)\s*THC\s*-\s*10ct\s*$",
        name,
        re.IGNORECASE,
    )
    if cones_match:
        flavor = clean_cultivar(cones_match.group(1))
        group_name = f"{flavor} Cones"
        return build_named_product(
            brand="Cannabals",
            category="Edibles",
            subcategory="Chocolate",
            group_name=group_name,
            variant_name=f"Cannabals {group_name} 10x 10mg",
            size="10mg",
            pack_count=10,
            search_term=group_name,
        )

    raise RuntimeError(f"Unhandled Cannabals product name: {name}")


def parse_layup_name(name: str) -> dict:
    flavor = None

    fast_acting_match = re.match(
        r"^LayUp\s*-\s*Beverage\s*-\s*Fast-Acting Distillate\s*-\s*1pk\s*-\s*(?:10\s*MG|10mg)\s*(?:THC)?\s*-\s*(.+?)\s*$",
        name,
        re.IGNORECASE,
    )
    if fast_acting_match:
        flavor = clean_cultivar(fast_acting_match.group(1))

    if not flavor:
        standard_match = re.match(
            r"^LayUp\s*-\s*Beverage\s*-\s*(.+?)\s*-\s*(?:10\s*MG|10mg)\s*(?:THC)?\s*$",
            name,
            re.IGNORECASE,
        )
        if standard_match:
            flavor = clean_cultivar(standard_match.group(1))

    if not flavor:
        raise RuntimeError(f"Unhandled LayUp product name: {name}")

    return build_named_product(
        brand="LayUp",
        category="Beverages",
        subcategory="",
        group_name=flavor,
        variant_name=f"LayUp {flavor} 10mg",
        size="10mg",
        pack_count=1,
        search_term=flavor,
    )


def parse_jennys_name(name: str) -> dict:
    cleaned = " ".join(name.split())
    preroll_match = re.fullmatch(
        r"Jenny's\s+J\s+1g\s+(.+?)\s+Pre-Roll",
        cleaned,
        flags=re.IGNORECASE,
    )
    if preroll_match:
        cultivar = clean_cultivar(preroll_match.group(1))
        group_name = f"J {cultivar}"
        return build_named_product(
            brand="Jenny's",
            category="Pre-Rolls",
            subcategory="",
            group_name=group_name,
            variant_name=f"Jenny's {group_name} 1g",
            size="1g",
            pack_count=1,
            search_term=cultivar,
            strain_name=cultivar,
        )

    raise RuntimeError(f"Unhandled Jenny's product name: {name}")


def parse_posh_puff_name(name: str) -> dict:
    cleaned = " ".join(name.split())
    vape_match = re.fullmatch(
        r"Posh\s+Puff\s+\.?5g\s+(.+?)\s+Vapes?",
        cleaned,
        flags=re.IGNORECASE,
    )
    if vape_match:
        cultivar = clean_cultivar(vape_match.group(1))
        group_name = f"Posh Puff {cultivar}"
        return build_named_product(
            brand="Jenny's",
            category="Vapes",
            subcategory="All In One / Disposable",
            group_name=group_name,
            variant_name=f"Jenny's {group_name} 0.5g",
            size="0.5g",
            pack_count=1,
            search_term=cultivar,
            strain_name=cultivar,
            effect_names=["Energetic", "Happy", "Creative", "Focused"],
        )

    raise RuntimeError(f"Unhandled Posh Puff product name: {name}")


def parse_outrankd_name(name: str) -> dict:
    match = re.match(r"^Outrankd\s*-\s*(.+?)\s*-\s*Disposable Vape\s*-\s*(\d+(?:\.\d+)?)g\s*$", name, re.IGNORECASE)
    if not match:
        raise RuntimeError(f"Unhandled Outrankd product name: {name}")

    cultivar = clean_cultivar(match.group(1))
    size = format_grams(float(match.group(2)))
    return {
        "brand": "Outrankd",
        "category": "Vapes",
        "subcategory": "",
        "groupName": cultivar,
        "variantTab": size,
        "variantName": f"Outrankd {cultivar} {size}",
        "size": size,
        "packCount": 1,
        "searchTerm": cultivar,
        "strainName": cultivar,
        "prevalence": None,
    }


def parse_the_gram_name(name: str) -> dict:
    match = re.match(r"^The Gram\s*-\s*(.+?)\s*-\s*Flower\s*-\s*(\d+(?:\.\d+)?)g\s*$", name, re.IGNORECASE)
    if not match:
        raise RuntimeError(f"Unhandled The Gram product name: {name}")

    cultivar = clean_cultivar(match.group(1))
    size = format_grams(float(match.group(2)))
    return {
        "brand": "The Gram",
        "category": "Pre-Rolls",
        "subcategory": "",
        "groupName": cultivar,
        "variantTab": size,
        "variantName": f"The Gram {cultivar} {size}",
        "size": size,
        "packCount": 1,
        "searchTerm": cultivar,
        "strainName": cultivar,
        "prevalence": None,
    }


def parse_moonlit_name(name: str) -> dict:
    match = re.match(
        r"^MOONLIT-\s*(.+?)\s+(\d+(?:\.\d+)?)\s*G\s+INFUSED\s+PREROLL\s*$",
        name,
        re.IGNORECASE,
    )
    if not match:
        raise RuntimeError(f"Unhandled Moonlit product name: {name}")

    raw_cultivar = match.group(1).strip()
    cultivar = clean_cultivar(raw_cultivar.title() if raw_cultivar.isupper() else raw_cultivar)
    size = format_grams(float(match.group(2)))
    return {
        "brand": "Moonlit Hash Co",
        "category": "Pre-Rolls",
        "subcategory": "Infused",
        "groupName": cultivar,
        "variantTab": size,
        "variantName": f"Moonlit Hash Co {cultivar} {size}",
        "size": size,
        "packCount": 1,
        "searchTerm": cultivar,
        "strainName": cultivar,
        "prevalence": None,
    }


def parse_smartbud_name(name: str) -> dict:
    match = re.match(
        r"^Smartbud\s*-\s*(\d+)Pk\s+Preroll\s*-\s*(.+?)\s*-\s*(\d+(?:\.\d+)?)g\s*$",
        name,
        re.IGNORECASE,
    )
    if not match:
        raise RuntimeError(f"Unhandled Smartbud product name: {name}")

    pack_count = int(match.group(1))
    total_grams = float(match.group(3))
    if pack_count <= 1:
        raise RuntimeError(f"Unhandled Smartbud pack size in product name: {name}")

    cultivar = clean_cultivar(match.group(2))
    size = format_grams(total_grams / pack_count)
    tab = f"{pack_count}x {size}"
    return {
        "brand": "Smartbud",
        "category": "Pre-Rolls",
        "subcategory": "",
        "groupName": cultivar,
        "variantTab": tab,
        "variantName": f"Smartbud {cultivar} {tab}",
        "size": size,
        "packCount": pack_count,
        "searchTerm": cultivar,
        "strainName": cultivar,
        "prevalence": None,
    }


def parse_herb_code_name(name: str) -> dict:
    cultivar = {
        "1O-PR-H26-DBUR": "Donny Burger",
        "1O-PR-H26-SDSL": "Sour Diesel",
        "1O-PR-H26-WIOG": "WiFi OG",
    }.get(name)
    if not cultivar:
        raise RuntimeError(f"Unhandled Herb coded product name: {name}")

    size = "1g"
    return {
        "brand": "Herb",
        "category": "Pre-Rolls",
        "subcategory": "",
        "groupName": cultivar,
        "variantTab": size,
        "variantName": f"Herb {cultivar} {size}",
        "size": size,
        "packCount": 1,
        "searchTerm": cultivar,
        "strainName": cultivar,
        "prevalence": None,
    }


def parse_field_of_dreams_name(name: str) -> dict:
    cleaned = " ".join(name.split())

    preroll_match = re.fullmatch(
        r"FOD\s*-\s*(.+?)\s+1G\s+Preroll\s*-\s*Flower\s*Only",
        cleaned,
        flags=re.IGNORECASE,
    )
    if preroll_match:
        cultivar = clean_cultivar(preroll_match.group(1))
        return build_named_product(
            brand="Field of Dreams",
            category="Pre-Rolls",
            subcategory="",
            group_name=cultivar,
            variant_name=f"Field of Dreams {cultivar} 1g",
            size="1g",
            pack_count=1,
            search_term=cultivar,
            strain_name=cultivar,
        )

    combo_match = re.fullmatch(
        r"FOD\s+(.+?)\s+1G\s*/\s*FOD\s+(.+?)\s+1G\s+Cart\s+Combo",
        cleaned,
        flags=re.IGNORECASE,
    )
    if combo_match:
        first = clean_cultivar(combo_match.group(1))
        second = clean_cultivar(combo_match.group(2))
        group_name = f"{first} + {second} Dual Chamber"
        return build_named_product(
            brand="Field of Dreams",
            category="Vapes",
            subcategory="All In One / Disposable",
            group_name=group_name,
            variant_name=f"Field of Dreams {first} + {second} 2g",
            size="2g",
            pack_count=1,
            search_term=f"{first} {second}",
            strain_name="",
        )

    if cleaned.upper() == "SOUR DIESEL":
        cultivar = "Sour Diesel"
        return build_named_product(
            brand="Field of Dreams",
            category="Flower",
            subcategory="Pre-Packaged Flower",
            group_name=cultivar,
            variant_name=f"Field of Dreams {cultivar} 3.5g",
            size="3.5g",
            pack_count=1,
            search_term=cultivar,
            strain_name=cultivar,
        )

    raise RuntimeError(f"Unhandled Field of Dreams product name: {name}")


def parse_house_of_sacci_name(name: str) -> dict:
    cleaned = " ".join(name.split())

    vape_match = re.fullmatch(
        r"(.+?)\s+1g\s+Vape",
        cleaned,
        flags=re.IGNORECASE,
    )
    if vape_match:
        cultivar = clean_cultivar(vape_match.group(1))
        return build_named_product(
            brand="House of Sacci",
            category="Vapes",
            subcategory="All In One / Disposable",
            group_name=cultivar,
            variant_name=f"House of Sacci {cultivar} 1g",
            size="1g",
            pack_count=1,
            search_term=cultivar,
            strain_name=cultivar,
        )

    dime_bag_match = re.fullmatch(
        r"(.+?)\s+\.?7g\s+Dime\s+Bag",
        cleaned,
        flags=re.IGNORECASE,
    )
    if dime_bag_match:
        cultivar = clean_cultivar(dime_bag_match.group(1))
        return build_named_product(
            brand="House of Sacci",
            category="Flower",
            subcategory="Pre-Packaged Flower",
            group_name=cultivar,
            variant_name=f"House of Sacci {cultivar} 0.7g Dime Bag",
            size="0.7g",
            pack_count=1,
            search_term=cultivar,
            strain_name=cultivar,
        )

    dogwalker_match = re.fullmatch(
        r"(.+?)\s+\.?5g\s+Dogwalker",
        cleaned,
        flags=re.IGNORECASE,
    )
    if dogwalker_match:
        cultivar = clean_cultivar(dogwalker_match.group(1))
        return build_named_product(
            brand="House of Sacci",
            category="Pre-Rolls",
            subcategory="",
            group_name=cultivar,
            variant_name=f"House of Sacci {cultivar} 0.5g Dogwalker",
            size="0.5g",
            pack_count=1,
            search_term=cultivar,
            strain_name=cultivar,
        )

    hash_match = re.fullmatch(
        r"(.+?)\s+1g\s+Hash",
        cleaned,
        flags=re.IGNORECASE,
    )
    if hash_match:
        cultivar = clean_cultivar(hash_match.group(1))
        return build_named_product(
            brand="House of Sacci",
            category="Concentrates",
            subcategory="Hash",
            group_name=cultivar,
            variant_name=f"House of Sacci {cultivar} 1g Hash",
            size="1g",
            pack_count=1,
            search_term=cultivar,
            strain_name=cultivar,
        )

    raise RuntimeError(f"Unhandled House of Sacci product name: {name}")


def parse_mfny_name(name: str) -> dict:
    """Parse MFNY catalog-correction names of the synthetic shape
    `MFNY <group name> <pack>x <size>g`, used here for the 4x 0.75g
    Blueberry 2.0 x Turbo Blueberry Resin variant create."""
    cleaned = " ".join(name.split())
    multipack_match = re.fullmatch(
        r"MFNY\s+(.+?)\s+(\d+)x\s+(\d+(?:\.\d+)?)g",
        cleaned,
        flags=re.IGNORECASE,
    )
    if multipack_match:
        group = clean_cultivar(multipack_match.group(1))
        pack_count = int(multipack_match.group(2))
        size_value = multipack_match.group(3)
        size = f"{size_value}g"
        return build_named_product(
            brand="MFNY",
            category="Pre-Rolls",
            subcategory="Infused",
            group_name=group,
            variant_name=f"MFNY {group} {pack_count}x {size}",
            size=size,
            pack_count=pack_count,
            search_term=group,
            strain_name=group,
        )
    raise RuntimeError(f"Unhandled MFNY product name: {name}")


def parse_ape_name(name: str) -> dict:
    cleaned = " ".join(name.split())
    pipe_match = re.fullmatch(
        r"APE\s*\|\s*(.+?)\s*\|\s*Preroll\s*\|\s*(\d+(?:\.\d+)?)g",
        cleaned,
        flags=re.IGNORECASE,
    )
    if pipe_match:
        cultivar = clean_cultivar(pipe_match.group(1))
        size_value = pipe_match.group(2)
        size = f"{size_value}g"
        return build_named_product(
            brand="APE",
            category="Pre-Rolls",
            subcategory="",
            group_name=cultivar,
            variant_name=f"APE {cultivar} {size}",
            size=size,
            pack_count=1,
            search_term=cultivar,
            strain_name=cultivar,
        )
    raise RuntimeError(f"Unhandled APE product name: {name}")


def parse_product_name(name: str) -> dict:
    normalized = name.strip()
    lowered = normalized.lower()
    if normalized.startswith(("Pr(", "F(", "V(")):
        return parse_curaleaf_name(normalized)
    if lowered.startswith("cannabals"):
        return parse_cannabals_name(normalized)
    if lowered.startswith("camino"):
        return parse_camino_name(normalized)
    if lowered.startswith("bytes"):
        return parse_bytes_name(normalized)
    if lowered.startswith("kiva"):
        return parse_kiva_name(normalized)
    if lowered.startswith("layup"):
        return parse_layup_name(normalized)
    if lowered.startswith("jenny's"):
        return parse_jennys_name(normalized)
    if lowered.startswith("posh puff"):
        return parse_posh_puff_name(normalized)
    if lowered.startswith("lost farm"):
        return parse_lost_farm_name(normalized)
    if lowered.startswith("outrankd"):
        return parse_outrankd_name(normalized)
    if lowered.startswith("the gram"):
        return parse_the_gram_name(normalized)
    if lowered.startswith("moonlit-"):
        return parse_moonlit_name(normalized)
    if lowered.startswith("smartbud"):
        return parse_smartbud_name(normalized)
    if normalized.startswith("1O-PR-H26-"):
        return parse_herb_code_name(normalized)
    if normalized.startswith("FOD") or normalized.upper() == "SOUR DIESEL":
        return parse_field_of_dreams_name(normalized)
    if re.search(r"\b(?:1g\s+Vape|\.?7g\s+Dime\s+Bag|\.?5g\s+Dogwalker|1g\s+Hash)\b", normalized, flags=re.IGNORECASE):
        return parse_house_of_sacci_name(normalized)
    if re.match(r"^APE\s*\|", normalized, flags=re.IGNORECASE):
        return parse_ape_name(normalized)
    if normalized.startswith("MFNY "):
        return parse_mfny_name(normalized)
    return parse_hrbotanical_name(normalized)


@lru_cache(maxsize=None)
def exact_reuse_product_id(distributor_product_name: str) -> int | None:
    if distributor_product_name in EXACT_REUSE_PRODUCT_IDS:
        return EXACT_REUSE_PRODUCT_IDS[distributor_product_name]

    parsed = parse_product_name(distributor_product_name)
    exact_query = parsed["variantName"]
    exact_compact = compact_text(exact_query)
    for row in cache.search(exact_query):
        row_name = row.get("name") or ""
        if compact_text(row_name) == exact_compact:
            return int(row["id"])
    return None


def family_anchor_products(parsed: dict) -> list[dict]:
    query = parsed["brand"]
    matches = []
    expected_category = parsed["category"]
    expected_subcategory = parsed["subcategory"]
    expected_size = parsed["size"]
    expected_pack_count = int(parsed["packCount"])
    for row in cache.search(query):
        product_id = int(row["id"])
        summary = cache.summary(product_id)
        if summary["category"] != expected_category:
            continue
        if expected_subcategory != (summary["subcategory"] or ""):
            continue
        if summary["size"] != expected_size:
            continue
        if int(summary["packCount"] or 1) != expected_pack_count:
            continue
        matches.append(summary)
    return matches


def exact_reuse_summary(distributor_product_name: str) -> dict | None:
    product_id = exact_reuse_product_id(distributor_product_name)
    if not product_id:
        return None
    return cache.summary(product_id)


def fetch_statewide_sources(parsed: dict) -> tuple[list[dict], str, tuple[int, ...]]:
    brand_ids = strict_statewide_brand_ids_for_name(parsed["brand"])
    search_terms = search_term_variants(parsed, brand_ids)
    request_url, headers, request_template = pending_order_statewide_request_template()
    expected_category = parsed["category"]
    filtered = []
    last_error: Exception | None = None
    for search_term in search_terms:
        request = copy.deepcopy(request_template)
        request["page"] = 0
        request["pagesize"] = 100
        request["dispensaryIDs"] = None
        request["stateID"] = preroll_helper.LITALERTS_STATE_ID
        request["filters"]["Name"] = search_term
        request["filters"]["StateID"] = str(preroll_helper.LITALERTS_STATE_ID)
        request["filters"].pop("Dispensary", None)
        category_id = LITALERTS_CATEGORY_ID_BY_CATEGORY.get(expected_category)
        if category_id:
            request["filters"]["CategoryId"] = category_id
        else:
            request["filters"].pop("CategoryId", None)
        if brand_ids:
            request["brandIDs"] = list(brand_ids)
            request["filters"]["Brand"] = json.dumps(list(brand_ids), separators=(",", ":"))
            strategy = "statewide-brand-search+variants" if len(search_terms) > 1 else "statewide-brand-search"
        else:
            request["brandIDs"] = []
            request["filters"]["Brand"] = "[]"
            strategy = "statewide-term-search+variants" if len(search_terms) > 1 else "statewide-term-search"

        try:
            response = preroll_helper.provider_post_json(request_url, headers, request)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            continue

        listings = response.get("listings") or []
        for item in listings:
            if not litalerts_category_matches(expected_category, item.get("category")):
                continue
            name_text = item.get("name") or ""
            brand_text = item.get("brand") or ""
            normalized_listing_text = normalize_text(f"{brand_text or ''} {name_text}")
            if not brand_ids:
                alias_keys = [normalize_text(alias) for alias in canonical_brand_aliases(parsed["brand"])]
                if not any(alias_key and alias_key in normalized_listing_text for alias_key in alias_keys):
                    continue
            for config in item.get("configs") or []:
                price_value = preroll_helper.parse_price_text(config.get("salePrice") or config.get("price"))
                if price_value is None:
                    continue
                if parsed["category"] == "Pre-Rolls":
                    if not listing_matches_preroll_format(parsed, name_text, config.get("weight")):
                        continue
                elif parsed["category"] == "Vapes":
                    grams = preroll_helper.parse_weight_to_grams(config.get("weight"))
                    expected_grams = preroll_helper.parse_weight_to_grams(parsed["size"])
                    if grams is not None and expected_grams is not None and abs(float(grams) - float(expected_grams)) > 0.11:
                        continue
                elif parsed["category"] == "Flower":
                    grams = preroll_helper.parse_weight_to_grams(config.get("weight"))
                    expected_grams = preroll_helper.parse_weight_to_grams(parsed["size"])
                    if grams is not None and expected_grams is not None and abs(float(grams) - float(expected_grams)) > 0.11:
                        continue

                filtered.append(
                    {
                        "label": f"{item.get('dispensaryName') or 'Statewide menu'} - {name_text}",
                        "listingName": name_text,
                        "dispensaryName": item.get("dispensaryName") or "",
                        "price": round(float(price_value), 2),
                        "url": item.get("url") or "",
                        "imageUrl": item.get("imageUrl") or "",
                        "brand": brand_text,
                        "category": item.get("category") or "",
                        "quantity": config.get("quantity"),
                        "weight": config.get("weight"),
                    }
                )

    if not filtered and last_error is not None:
        raise last_error

    deduped = []
    seen = set()
    for source in filtered:
        key = (source["label"], source["price"], source["url"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(source)
    return deduped, strategy, brand_ids


def build_row(position_group: dict) -> dict:
    distributor_product_name = position_group["distributorProductName"]
    parsed = parse_product_name(distributor_product_name)
    reuse = exact_reuse_summary(distributor_product_name)
    anchors = family_anchor_products(parsed)
    anchor_price = median([row["price"] for row in anchors]) if anchors else None
    effective_cost = position_group["effectiveUnitCost"]
    pricing_note = ""

    lit_sources, lit_strategy, lit_brand_ids = fetch_statewide_sources(parsed)
    average_lit_price = round(sum(source["price"] for source in lit_sources) / len(lit_sources), 2) if lit_sources else None
    primary_image = choose_primary_image(reuse, anchors, lit_sources)

    if reuse:
        proposed_action = (
            f"Map the live purchase distributor product onto existing variant {reuse['productName']} "
            f"(product {reuse['productId']}) and avoid a duplicate catalog row."
        )
        proposed_price = reuse["price"]
        action_type = "mapping-only"
        notes = []
        if lit_sources:
            notes.append(
                f"Lit Alerts still surfaces {len(lit_sources)} matching statewide listing(s), which supports the naming even though the row already exists live."
            )
    else:
        fallback_price = anchor_price
        proposed_price, pricing_note = recommended_row_price(effective_cost, average_lit_price, fallback_price)
        proposed_action = (
            f"Create new {parsed['variantName']} under {parsed['category']}"
            + (f" / {parsed['subcategory']}" if parsed['subcategory'] else "")
            + ", then link the existing purchase distributor product to the created variant."
        )
        action_type = "catalog-create"
        notes = [pricing_note] if pricing_note else []
        if anchors:
            notes.append(
                f"Anchor family price uses {len(anchors)} live same-format {parsed['brand']} row(s): {', '.join(str(row['productId']) for row in anchors[:5])}."
            )
        if not lit_sources:
            notes.append("No exact Lit Alerts state-wide match survived the format/category filter, so this leans on live family pricing or the GM floor.")

    if position_group["sampleLike"]:
        notes.append("At least one linked order position is nominal-cost sample-like, so the paid companion rows drive the cost basis where available.")

    source_details = [
        {
            **source,
            "postTaxPrice": round(float(source["price"]) * POST_TAX_MULTIPLIER, 2),
            "distanceBucket": "statewide",
            "distanceLabel": "statewide",
            "retailerDistanceMiles": None,
            "dispensaryAddress": "",
            "subcategory": "",
        }
        for source in lit_sources
    ]
    post_tax_prices = [float(source["postTaxPrice"]) for source in source_details]
    average_post_tax_price = round(float(average_lit_price) * POST_TAX_MULTIPLIER, 2) if average_lit_price is not None else None
    competitor_min_post_tax = round(min(post_tax_prices), 2) if post_tax_prices else average_post_tax_price
    competitor_max_post_tax = round(max(post_tax_prices), 2) if post_tax_prices else average_post_tax_price
    competitor_median_post_tax = round(float(median(post_tax_prices)), 2) if post_tax_prices else average_post_tax_price
    competitor_q1_post_tax = quantile(post_tax_prices, 0.25) if post_tax_prices else average_post_tax_price
    competitor_q3_post_tax = quantile(post_tax_prices, 0.75) if post_tax_prices else average_post_tax_price

    current_price = reuse["price"] if reuse else anchor_price
    current_price_basis = "exact live reuse" if reuse else "live family anchor"
    if current_price is None and average_post_tax_price is not None:
        current_price = average_post_tax_price
        current_price_basis = "post-tax market average fallback"
    elif current_price is None and proposed_price is not None:
        current_price = proposed_price
        current_price_basis = "proposed fallback"

    pricing_reason_parts = []
    if pricing_note:
        pricing_reason_parts.append(pricing_note)
    if reuse:
        pricing_reason_parts.append("The exact live reusable variant already exists, so its current shelf price is the primary reference point.")
    elif anchor_price is not None:
        pricing_reason_parts.append("The live same-format family anchor median is available and is used as the current-basis reference for this draft.")
    elif average_post_tax_price is not None:
        pricing_reason_parts.append("No live family anchor exists, so the post-tax Lit Alerts statewide average is acting as the current-basis reference.")
    pricing_reason_parts.append(f"Lit Alerts strategy: {lit_strategy}.")
    pricing_reason = " ".join(part for part in pricing_reason_parts if part).strip()

    pricing_action = classify_pricing_action(current_price, proposed_price)
    current_gm = gm_percent(effective_cost, current_price)
    pricing_domain_min, pricing_domain_max = pricing_domain_bounds(
        [
            current_price,
            proposed_price,
            average_post_tax_price,
            competitor_min_post_tax,
            competitor_max_post_tax,
        ]
    )

    reviewer_price_override = PENDING_PRICE_OVERRIDES.get(position_group["distributorProductId"])
    if reviewer_price_override is not None:
        proposed_price = reviewer_price_override["proposedPrice"]
        pricing_action = classify_pricing_action(current_price, proposed_price)
        pricing_reason = f"{reviewer_price_override['reason']} {pricing_reason}".strip()

    review_flags = review_flags_for_row(lit_sources, proposed_price, anchors, primary_image)

    return {
        "distributorProductId": position_group["distributorProductId"],
        "orderIds": position_group["orderIds"],
        "positionIds": position_group["positionIds"],
        "sampleLike": position_group["sampleLike"],
        "distributorProductName": distributor_product_name,
        "expectedCategory": parsed["category"],
        "expectedSubcategory": parsed["subcategory"],
        "targetBrand": parsed["brand"],
        "targetGroupName": parsed["groupName"],
        "targetVariantName": reuse["productName"] if reuse else parsed["variantName"],
        "targetVariantTab": reuse["tab"] if reuse else parsed["variantTab"],
        "targetStrain": parsed.get("strainName") or "",
        "targetPrevalence": parsed["prevalence"] or "",
        "actionType": action_type,
        "proposedAction": proposed_action,
        "reuseProductId": reuse["productId"] if reuse else None,
        "reuseProductName": reuse["productName"] if reuse else "",
        "anchorProductIds": [row["productId"] for row in anchors],
        "anchorPrice": anchor_price,
        "effectiveUnitCost": effective_cost,
        "proposedPrice": proposed_price,
        "gmPercent": gm_percent(effective_cost, proposed_price),
        "currentPrice": current_price,
        "currentPriceBasis": current_price_basis,
        "currentGmPercent": current_gm,
        "pricingAction": pricing_action,
        "pricingReason": pricing_reason,
        "averageLitAlertsPrice": average_lit_price,
        "averageCompetitorPostTaxPrice": average_post_tax_price,
        "competitorMinPostTaxPrice": competitor_min_post_tax,
        "competitorMaxPostTaxPrice": competitor_max_post_tax,
        "competitorMedianPostTaxPrice": competitor_median_post_tax,
        "competitorQ1PostTaxPrice": competitor_q1_post_tax,
        "competitorQ3PostTaxPrice": competitor_q3_post_tax,
        "pricingDomainMin": pricing_domain_min,
        "pricingDomainMax": pricing_domain_max,
        "pricingEvidenceStrategy": lit_strategy,
        "pricingEvidenceRetailerMatchCount": len({source.get('dispensaryName') or source.get('label') or '' for source in source_details}),
        "pricingEvidenceProviderMatchCount": len(source_details),
        "pricingEvidenceRadiusMiles": None,
        "pricingEvidenceSourceDetails": source_details,
        "litAlertsMatchCount": len(lit_sources),
        "litAlertsStrategy": lit_strategy,
        "litAlertsBrandIds": list(lit_brand_ids),
        "litAlertsSampleSources": lit_sources[:6],
        "primaryImageSource": primary_image["source"],
        "primaryImageUrl": primary_image["url"],
        "primaryImageHref": primary_image["href"],
        "primaryImageNote": primary_image["note"],
        "reviewFlags": review_flags,
        "notes": " ".join(note for note in notes if note).strip(),
    }


def nominal_sample_like(position: dict) -> bool:
    price = float(position.get("discountProductPrice") or 0)
    if price <= 0.05:
        return True
    wholesale = (position.get("orderPositionIntegrationData") or {}).get("wholesalePrice")
    return wholesale is not None and float(wholesale or 0) <= 0.05


def effective_unit_cost(position: dict, grouped_positions: list[dict]) -> float | None:
    direct = float(position.get("discountProductPrice") or 0)
    if direct > 0.05:
        return direct
    wholesale = (position.get("orderPositionIntegrationData") or {}).get("wholesalePrice")
    qty = float(position.get("qty") or 0) or 1
    if wholesale is not None and float(wholesale) > 0.05:
        return round(float(wholesale) / qty, 2)
    for other in grouped_positions:
        if other is position:
            continue
        other_direct = float(other.get("discountProductPrice") or 0)
        if other_direct > 0.05:
            return other_direct
        other_wholesale = (other.get("orderPositionIntegrationData") or {}).get("wholesalePrice")
        other_qty = float(other.get("qty") or 0) or 1
        if other_wholesale is not None and float(other_wholesale) > 0.05:
            return round(float(other_wholesale) / other_qty, 2)
    return None


def collect_pending_groups() -> tuple[list[dict], list[dict]]:
    switch_context(SITE_DEALER_ID, SITE_DEALER_NAME)
    queue = sweed_attr.api_call(
        "store.purchase.order.list",
        {
            "orderStatusId": 2,
            "fromDate": ORDER_LIST_FROM_DATE,
            "toDate": ORDER_LIST_TO_DATE,
            "page": 1,
            "pageSize": 50,
        },
    )
    grouped: dict[str, list[dict]] = defaultdict(list)
    live_orders = []
    for order_row in queue.get("data") or []:
        order_id = int(order_row["id"])
        switch_context(SITE_DEALER_ID, SITE_DEALER_NAME)
        order = sweed_attr.api_call("store.purchase.order.get", {"id": order_id})
        switch_context(SITE_DEALER_ID, SITE_DEALER_NAME)
        suggestion = sweed_attr.api_call("store.distributor.product.suggestion", {"orderId": order_id})
        suggestion_rows = [
            item for item in (suggestion.get("orderPositions") or []) if not is_placeholder_suggestion_row(item)
        ]
        unresolved_ids = {
            str(item["orderPositionId"])
            for item in suggestion_rows
            if item.get("orderPositionId") is not None
        }
        queued_position_ids: set[int] = set()
        for position in order.get("positions") or []:
            mapped_product_name = normalize_text((((position.get("distributorProduct") or {}).get("product") or {}).get("name") or ""))
            has_generic_placeholder_mapping = (
                not position.get("suggestedProduct")
                and mapped_product_name in GENERIC_PLACEHOLDER_PRODUCT_NAMES
            )
            if str(position["id"]) not in unresolved_ids and not has_generic_placeholder_mapping:
                continue
            queued_position_ids.add(int(position["id"]))
            position["_orderId"] = order_id
            position["_externalOrderId"] = order.get("externalOrderId") or ""
            grouped[str((position.get("distributorProduct") or {}).get("id"))].append(position)
        live_orders.append(
            {
                "orderId": order_id,
                "externalOrderId": order.get("externalOrderId") or "",
                "distributor": (order.get("distributor") or {}).get("name") or "",
                "deliveryDate": order.get("deliveryDate") or "",
                "positionCount": len(order.get("positions") or []),
                "unresolvedPositionCount": len(queued_position_ids),
            }
        )

    groups = []
    for positions in grouped.values():
        first = positions[0]
        distributor_product = first.get("distributorProduct") or {}
        groups.append(
            {
                "distributorProductId": distributor_product.get("id"),
                "distributorProductName": distributor_product.get("name") or "",
                "orderIds": sorted({int(position["_orderId"]) for position in positions}),
                "positionIds": sorted(int(position["id"]) for position in positions),
                "sampleLike": any(nominal_sample_like(position) for position in positions),
                "effectiveUnitCost": effective_unit_cost(first, positions),
            }
        )

    groups.sort(key=lambda row: (row["orderIds"][0], row["distributorProductName"].lower()))
    return live_orders, groups


def render_source_card(source: dict) -> str:
    listing_name = source.get("listingName") or source.get("label") or "Statewide menu listing"
    dispensary_name = source.get("dispensaryName") or "Statewide menu"
    thumb_href = source.get("url") or source.get("imageUrl") or ""
    thumb_html = render_thumb(source.get("imageUrl") or "", listing_name, thumb_href, class_name="source-thumb")
    weight = source.get("weight") or "unknown weight"
    category = source.get("category") or ""
    link_html = (
        f'<a href="{html.escape(source["url"])}" target="_blank" rel="noopener noreferrer">Open listing</a>'
        if source.get("url")
        else '<span class="muted">No listing URL</span>'
    )
    return f"""
      <article class="source-card">
        {thumb_html}
        <div class="source-body">
          <div class="source-title">{html.escape(dispensary_name)}</div>
          <div class="muted">{html.escape(listing_name)}</div>
          <div class="source-price">{money_or_dash(source.get('price'))}</div>
          <div class="muted">{html.escape(category)}{(' - ' + html.escape(str(weight))) if weight else ''}</div>
          <div class="muted">{link_html}</div>
        </div>
      </article>
    """


def render_source_grid(row: dict) -> str:
    if not row["litAlertsSampleSources"]:
        return (
            "<div class='empty-evidence'>"
            "<strong>Missing Lit Alerts evidence.</strong><br>"
            "This row remains in the packet for review, but the current statewide search did not produce a same-format listing that survived the active filter."
            "</div>"
        )
    return f"<div class='source-grid'>{''.join(render_source_card(source) for source in row['litAlertsSampleSources'])}</div>"


def render_notes(row: dict) -> str:
    notes = [row["notes"]] if row.get("notes") else []
    if row["anchorProductIds"]:
        notes.append(
            "Live family anchors: " + ", ".join(str(product_id) for product_id in row["anchorProductIds"][:8])
        )
    notes.append(f"Lit Alerts strategy: {row['litAlertsStrategy']}")
    if row["litAlertsBrandIds"]:
        notes.append("Lit Alerts brand IDs: " + ", ".join(str(value) for value in row["litAlertsBrandIds"]))
    return "".join(f"<li>{html.escape(note)}</li>" for note in notes if note)


def render_flag_chips(row: dict) -> str:
    chips = [
        chip(row["actionType"].replace("-", " "), "mapping" if row["actionType"] == "mapping-only" else "catalog"),
        chip(row["primaryImageSource"], "image" if row["primaryImageUrl"] else "neutral"),
    ]
    if row["litAlertsMatchCount"]:
        chips.append(chip(f"{row['litAlertsMatchCount']} lit alerts matches", "evidence"))
    else:
        chips.append(chip("no lit alerts matches", "warning"))
    if row["sampleLike"]:
        chips.append(chip("sample-like cost", "neutral"))
    for flag in row["reviewFlags"]:
        class_name = "danger" if flag == "Needs manual price" else "warning"
        chips.append(chip(flag, class_name))
    return "".join(chips)


def detail_page_filename(row: dict) -> str:
    return f"{row['distributorProductId']}.html"


def render_detail_evidence_table(row: dict) -> str:
    return render_market_price_table(row)


def render_detail_page(row: dict) -> str:
    primary_thumb = render_thumb(
        row["primaryImageUrl"],
        row["targetVariantName"],
        row.get("primaryImageHref") or row["primaryImageUrl"],
        class_name="detail-thumb",
    )
    subcategory = row["expectedSubcategory"] or "-"
    strain_line = row["targetStrain"] or "-"
    if row["targetPrevalence"]:
        strain_line += f" ({row['targetPrevalence']})"
    reuse_line = (
        f"{row['reuseProductName']} (product {row['reuseProductId']})"
        if row["reuseProductId"]
        else "No exact live variant reuse found yet"
    )
    flags_html = render_flag_chips(row)
    notes_items = []
    if row.get("notes"):
        notes_items.append(row["notes"])
    if row["anchorProductIds"]:
        notes_items.append("Live family anchors: " + ", ".join(str(value) for value in row["anchorProductIds"]))
    if row["litAlertsBrandIds"]:
        notes_items.append("Lit Alerts brand IDs: " + ", ".join(str(value) for value in row["litAlertsBrandIds"]))
    notes_html = "".join(f"<li>{html.escape(item)}</li>" for item in notes_items)
    review_flags_html = "".join(f"<li>{html.escape(flag)}</li>" for flag in row["reviewFlags"])
    evidence_coverage = pricing_evidence_coverage_text(row)
    current_gm_text = f"{row['currentGmPercent']:.2f}% GM" if row.get("currentGmPercent") is not None else "GM unavailable"
    proposed_gm_text = f"{row['gmPercent']:.2f}% GM" if row.get("gmPercent") is not None else "GM unavailable"
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{html.escape(row['targetVariantName'])} - Pending Order Proposal Detail</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f2eee5;
      --card: #fffaf1;
      --ink: #1f1b17;
      --muted: #6d665b;
      --line: #d9ceb7;
      --catalog: #27417e;
      --mapping: #1f5d42;
      --evidence: #614478;
      --warning: #8b5e11;
      --danger: #8d2f52;
      --image: #916c1e;
      --neutral: #6d665b;
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
    .muted {{ color: var(--muted); }}
    .metric {{ font-weight: 700; }}
    .chip {{ display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #fff; margin: 0 6px 6px 0; }}
    .chip.catalog {{ background: var(--catalog); }}
    .chip.mapping {{ background: var(--mapping); }}
    .chip.evidence {{ background: var(--evidence); }}
    .chip.warning {{ background: var(--warning); }}
    .chip.danger {{ background: var(--danger); }}
    .chip.image {{ background: var(--image); }}
    .chip.neutral {{ background: var(--neutral); }}
    .thumb-link, .thumb-empty {{ display: inline-flex; width: 100%; aspect-ratio: 1 / 1; align-items: center; justify-content: center; border-radius: 16px; border: 1px solid var(--line); overflow: hidden; background: #f8f1e5; }}
    .thumb-link img {{ width: 100%; height: 100%; object-fit: cover; }}
    .detail-thumb {{ max-width: 240px; }}
    .section-grid {{ display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr); gap: 18px; margin-top: 18px; }}
    .detail-grid {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; }}
    .detail-grid div {{ font-size: 14px; line-height: 1.5; }}
    .pricing-ladder-shell {{ margin-top: 6px; }}
    .pricing-ladder-shell.is-detail {{ margin-top: 12px; }}
    .pricing-ladder-head {{ display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; margin-bottom: 12px; }}
    .metric-detail {{ font-weight: 400; }}
    .pricing-ladder {{ position: relative; height: 96px; margin: 6px 0 8px; }}
    .pricing-ladder.is-detail {{ height: 172px; margin: 10px 0 12px; }}
    .ladder-track {{ position: absolute; left: 0; right: 0; top: 34px; height: 4px; border-radius: 999px; background: #d9ceb7; }}
    .pricing-ladder.is-detail .ladder-track {{ top: 88px; }}
    .ladder-iqr {{ position: absolute; top: 28px; height: 16px; border-radius: 999px; background: rgba(39, 65, 126, 0.18); border: 1px solid rgba(39, 65, 126, 0.26); }}
    .pricing-ladder.is-detail .ladder-iqr {{ top: 80px; }}
    .ladder-median {{ position: absolute; top: 22px; width: 2px; height: 28px; background: #27417e; }}
    .pricing-ladder.is-detail .ladder-median {{ top: 74px; height: 32px; }}
    .ladder-competitor {{ position: absolute; width: 10px; height: 10px; margin-left: -5px; border-radius: 999px; border: 1px solid rgba(31, 27, 23, 0.25); box-shadow: 0 0 0 2px rgba(255, 250, 241, 0.85); background: var(--evidence); }}
    .ladder-competitor.statewide, .ladder-competitor.unknown {{ background: var(--evidence); }}
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
    .notes-list, .flag-list {{ margin: 8px 0 0; padding-left: 18px; }}
    .notes-list li, .flag-list li {{ margin: 4px 0; }}
    .source-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-top: 10px; }}
    .source-card {{ display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; padding: 10px; border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,0.7); }}
    .source-thumb, .source-thumb.thumb-empty {{ width: 76px; height: 76px; border-radius: 12px; }}
    .source-body {{ min-width: 0; }}
    .source-title {{ font-weight: 700; margin-bottom: 2px; overflow-wrap: anywhere; }}
    .source-price {{ font-weight: 700; color: var(--catalog); }}
    .match-chip {{ display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid transparent; }}
    .match-chip.match-exact {{ background: rgba(31, 93, 66, 0.12); color: #1f5d42; border-color: rgba(31, 93, 66, 0.3); }}
    .match-chip.match-family {{ background: rgba(39, 65, 126, 0.1); color: #27417e; border-color: rgba(39, 65, 126, 0.24); }}
    .match-chip.match-cultivar {{ background: rgba(97, 68, 120, 0.1); color: #614478; border-color: rgba(97, 68, 120, 0.24); }}
    .match-chip.match-equivalent {{ background: rgba(109, 102, 91, 0.1); color: #6d665b; border-color: rgba(109, 102, 91, 0.24); }}
    .market-table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
    .market-table th, .market-table td {{ padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }}
    .market-table th {{ font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }}
    .market-row.match-exact td {{ background: rgba(31, 93, 66, 0.04); }}
    .empty-evidence {{ margin-top: 10px; padding: 12px 14px; border: 1px dashed rgba(139, 94, 17, 0.4); border-radius: 14px; background: rgba(139, 94, 17, 0.06); }}
    @media (max-width: 960px) {{
      .hero {{ grid-template-columns: 1fr; }}
      .section-grid, .detail-grid {{ grid-template-columns: 1fr; }}
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <a class="back-link" href="../{OUTPUT_HTML_PATH.name}">Back to pending-order packet</a>
      <span class="muted">Click listing links for the original Lit Alerts source pages.</span>
    </div>

    <section class="hero">
      <div class="hero-card">
        {primary_thumb}
        <div class="muted" style="margin-top: 10px;">{html.escape(row['primaryImageNote'])}</div>
      </div>
      <div class="hero-card">
        <h1>{html.escape(row['targetVariantName'])}</h1>
        <div class="meta">Distributor product {html.escape(row['distributorProductName'])}<br>DP {row['distributorProductId']} - orders {', '.join(str(value) for value in row['orderIds'])} - positions {', '.join(str(value) for value in row['positionIds'])}</div>
        <div style="margin-top: 12px;">{pricing_action_chip(row)}{flags_html}</div>
        {render_pricing_ladder(row, detail=True)}
        <div class="detail-grid" style="margin-top: 12px;">
          <div><span class="muted">Target brand</span><br><span class="metric">{html.escape(row['targetBrand'])}</span></div>
          <div><span class="muted">Target group</span><br><span class="metric">{html.escape(row['targetGroupName'])}</span></div>
          <div><span class="muted">Target tab</span><br><span class="metric">{html.escape(row['targetVariantTab'])}</span></div>
          <div><span class="muted">Category lane</span><br><span class="metric">{html.escape(row['expectedCategory'])} / {html.escape(subcategory)}</span></div>
        </div>
      </div>
    </section>

    <div class="section-grid">
      <section class="section">
        <h2>Pricing Context</h2>
        <div class="detail-grid">
          <div><span class="muted">Current basis</span><br><span class="metric">{compact_currency(row['currentPrice'])}</span> <span class="muted">({current_gm_text})</span></div>
          <div><span class="muted">Proposed</span><br><span class="metric">{compact_currency(row['proposedPrice'])}</span> <span class="muted">({proposed_gm_text})</span></div>
          <div><span class="muted">Market avg</span><br><span class="metric">{compact_currency(row['averageCompetitorPostTaxPrice'])}</span></div>
          <div><span class="muted">Evidence coverage</span><br><span class="metric">{html.escape(evidence_coverage)}</span></div>
          <div><span class="muted">Effective cost</span><br><span class="metric">{compact_currency(row['effectiveUnitCost'])}</span></div>
          <div><span class="muted">Pricing reason</span><br>{html.escape(row['pricingReason'])}</div>
        </div>
      </section>

      <section class="section">
        <h2>Catalog Context</h2>
        <div class="detail-grid">
          <div><span class="muted">Proposed action</span><br>{html.escape(row['proposedAction'])}</div>
          <div><span class="muted">Reuse status</span><br>{html.escape(reuse_line)}</div>
          <div><span class="muted">Target strain</span><br><span class="metric">{html.escape(strain_line)}</span></div>
          <div><span class="muted">Current price basis</span><br><span class="metric">{html.escape(row['currentPriceBasis'])}</span></div>
          <div><span class="muted">Action type</span><br><span class="metric">{html.escape(row['actionType'])}</span></div>
          <div><span class="muted">Sample-like</span><br><span class="metric">{'Yes' if row['sampleLike'] else 'No'}</span></div>
          <div style="grid-column: 1 / -1;"><span class="muted">Notes</span><br>{('<ul class="notes-list">' + notes_html + '</ul>') if notes_html else '<span class="muted">No extra notes recorded.</span>'}</div>
          <div style="grid-column: 1 / -1;"><span class="muted">Review flags</span><br>{('<ul class="flag-list">' + review_flags_html + '</ul>') if review_flags_html else '<span class="muted">No reviewer flags on this row.</span>'}</div>
        </div>
      </section>
    </div>

    <section class="section" style="margin-top: 18px;">
      <h2>Evidence Cards</h2>
      <p class="muted">This is the same reviewer evidence from the packet row, expanded so you can inspect each source without staying in the dense table.</p>
      {render_source_grid(row)}
    </section>

    <section class="section" style="margin-top: 18px;">
      <h2>Enumerated Lit Alerts Sources</h2>
      <p class="muted">This view lists every retained statewide competitor price so duplicate-price stacks are readable even when the compact ladder gets crowded.</p>
      {render_detail_evidence_table(row)}
    </section>
  </div>
</body>
</html>
"""


def write_detail_pages(rows: list[dict]) -> None:
    OUTPUT_DETAIL_DIR.mkdir(exist_ok=True)
    for existing_path in OUTPUT_DETAIL_DIR.glob("*.html"):
        existing_path.unlink()
    for row in rows:
        (OUTPUT_DETAIL_DIR / detail_page_filename(row)).write_text(render_detail_page(row))


def render_packet_row(row: dict) -> str:
    primary_thumb = render_thumb(
        row["primaryImageUrl"],
        row["targetVariantName"],
        row.get("primaryImageHref") or row["primaryImageUrl"],
    )
    notes_html = render_notes(row)
    review_flags_html = "".join(f"<li>{html.escape(flag)}</li>" for flag in row["reviewFlags"])
    subcategory = row["expectedSubcategory"] or "-"
    reuse_line = (
        f"Reuse product {row['reuseProductId']} - {html.escape(row['reuseProductName'])}"
        if row["reuseProductId"]
        else "No exact live variant reuse found yet"
    )
    target_line = row["targetStrain"] or "-"
    if row["targetPrevalence"]:
        target_line += f" ({row['targetPrevalence']})"
    pricing_ladder_html = render_pricing_ladder(row)
    return f"""
      <tr class="product-row" data-detail-href="{html.escape(OUTPUT_DETAIL_DIR.name)}/{html.escape(detail_page_filename(row))}">
        <td>
          <div class="meta-stack">
            <strong>{html.escape(row['targetVariantName'])}</strong>
            <span class="muted">{html.escape(row['targetBrand'])} - DP {row['distributorProductId']}</span>
            <span class="muted">Orders {', '.join(str(value) for value in row['orderIds'])} - positions {', '.join(str(value) for value in row['positionIds'])}</span>
            <span class="muted">{html.escape(row['expectedCategory'])} / {html.escape(subcategory)} - {html.escape(row['targetVariantTab'])}</span>
            <span class="muted">Source name: {html.escape(row['distributorProductName'])}</span>
          </div>
        </td>
        <td>
          {chip(row['primaryImageSource'], 'image' if row['primaryImageUrl'] else 'neutral')}<br>
          {primary_thumb}
          <div class="muted">{html.escape(row['primaryImageNote'])}</div>
        </td>
        <td>
          {pricing_action_chip(row)}<br>
          {pricing_ladder_html}
          <div class="pricing-note muted">{html.escape(row['pricingReason'])}</div>
        </td>
        <td>
          <div class="meta-stack">
            {chip(row['actionType'].replace('-', ' '), 'mapping' if row['actionType'] == 'mapping-only' else 'catalog')}
            {chip(f"{row['litAlertsMatchCount']} lit alerts matches", 'evidence' if row['litAlertsMatchCount'] else 'warning')}
            <span><span class="muted">Current price basis</span><br><span class="metric">{compact_currency(row['currentPrice'])}</span> - {html.escape(row['currentPriceBasis'])}</span>
            <span><span class="muted">Target strain</span><br><span class="metric">{html.escape(target_line)}</span></span>
            <span><span class="muted">Reuse status</span><br>{reuse_line}</span>
            <span><span class="muted">Proposed action</span><br>{html.escape(row['proposedAction'])}</span>
          </div>
        </td>
        <td>
          <div class="muted">Lit Alerts strategy: {html.escape(row['litAlertsStrategy'])}</div>
          <div class="muted">Coverage: {html.escape(pricing_evidence_coverage_text(row))}</div>
          <div class="muted">Effective cost: {compact_currency(row['effectiveUnitCost'])}</div>
          {('<ul class="notes-list">' + notes_html + '</ul>') if notes_html else ''}
          {('<ul class="flag-list">' + review_flags_html + '</ul>') if review_flags_html else ''}
        </td>
      </tr>
    """


def render_brand_table(rows: list[dict]) -> str:
    sorted_rows = sorted(rows, key=lambda row: (row["targetVariantName"].lower(), row["distributorProductName"].lower()))
    return f"""
      <table class="group-table">
        <colgroup>
          <col style="width: 22%;">
          <col style="width: 14%;">
          <col style="width: 30%;">
          <col style="width: 20%;">
          <col style="width: 14%;">
        </colgroup>
        <thead>
          <tr>
            <th>Product</th>
            <th>Picture</th>
            <th>Pricing</th>
            <th>Catalog</th>
            <th>Proposal Notes</th>
          </tr>
        </thead>
        <tbody>
          {''.join(render_packet_row(row) for row in sorted_rows)}
        </tbody>
      </table>
    """


def render_grouped_packet(rows: list[dict]) -> str:
    hierarchy: dict[str, dict[str, dict[str, dict[str, list[dict]]]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    )
    for row in rows:
        subcategory = row["expectedSubcategory"] or "Unspecified"
        hierarchy[row["expectedCategory"]][subcategory][row["targetVariantName"]][row["targetBrand"]].append(row)

    sections = []
    for category, subcategory_map in sorted(hierarchy.items()):
        category_count = sum(
            len(brand_rows)
            for variant_map in subcategory_map.values()
            for brand_map in variant_map.values()
            for brand_rows in brand_map.values()
        )
        subcategory_sections = []
        for subcategory, variant_map in sorted(subcategory_map.items()):
            subcategory_count = sum(
                len(brand_rows)
                for brand_map in variant_map.values()
                for brand_rows in brand_map.values()
            )
            variant_sections = []
            for variant_name, brand_map in sorted(variant_map.items()):
                variant_count = sum(len(brand_rows) for brand_rows in brand_map.values())
                brand_sections = []
                for brand, brand_rows in sorted(brand_map.items()):
                    brand_sections.append(
                        f"""
        <details class="group-block group-brand" open>
          <summary>
            <span class="group-kicker">Brand</span>
            <strong>{html.escape(brand)}</strong>
            <span class="group-count">{len(brand_rows)} row{'s' if len(brand_rows) != 1 else ''}</span>
          </summary>
          <div class="group-content">
            {render_brand_table(brand_rows)}
            {group_footer('Brand')}
          </div>
        </details>
                        """
                    )
                variant_sections.append(
                    f"""
        <details class="group-block group-variant" open>
          <summary>
            <span class="group-kicker">Variant</span>
            <strong>{html.escape(variant_name)}</strong>
            <span class="group-count">{variant_count} row{'s' if variant_count != 1 else ''}</span>
          </summary>
          <div class="group-content">
            {''.join(brand_sections)}
            {group_footer('Variant')}
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
          <span class="group-count">{subcategory_count} row{'s' if subcategory_count != 1 else ''}</span>
        </summary>
        <div class="group-content">
          {''.join(variant_sections)}
          {group_footer('Subcategory')}
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
          <span class="group-count">{category_count} row{'s' if category_count != 1 else ''}</span>
        </summary>
        <div class="group-content">
          {''.join(subcategory_sections)}
          {group_footer('Category')}
        </div>
      </details>
            """
        )
    return ''.join(sections)


def write_outputs(payload: dict) -> None:
    OUTPUT_JSON_PATH.write_text(json.dumps(payload, indent=2) + "\n")

    with OUTPUT_CSV_PATH.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_HEADERS)
        writer.writeheader()
        for row in payload["rows"]:
            writer.writerow(
                {
                    "Distributor Product ID": row["distributorProductId"],
                    "Order IDs": ", ".join(str(value) for value in row["orderIds"]),
                    "Position IDs": ", ".join(str(value) for value in row["positionIds"]),
                    "Distributor Product Name": row["distributorProductName"],
                    "Expected Category": row["expectedCategory"],
                    "Expected Subcategory": row["expectedSubcategory"],
                    "Target Brand": row["targetBrand"],
                    "Target Group Name": row["targetGroupName"],
                    "Target Variant Name": row["targetVariantName"],
                    "Target Variant Tab": row["targetVariantTab"],
                    "Target Strain": row["targetStrain"],
                    "Target Prevalence": row["targetPrevalence"],
                    "Proposed Action": row["proposedAction"],
                    "Action Type": row["actionType"],
                    "Reuse Product ID": row["reuseProductId"] or "",
                    "Reuse Product Name": row["reuseProductName"],
                    "Anchor Product IDs": ", ".join(str(value) for value in row["anchorProductIds"]),
                    "Anchor Price": money(row["anchorPrice"]),
                    "Effective Unit Cost": money(row["effectiveUnitCost"]),
                    "Proposed Global Price": money(row["proposedPrice"]),
                    "GM%": row["gmPercent"] if row["gmPercent"] is not None else "",
                    "Average Lit Alerts Price": money(row["averageLitAlertsPrice"]),
                    "Lit Alerts Match Count": row["litAlertsMatchCount"],
                    "Lit Alerts Strategy": row["litAlertsStrategy"],
                    "Lit Alerts Brand IDs": ", ".join(str(value) for value in row["litAlertsBrandIds"]),
                    "Lit Alerts Source Samples": " | ".join(
                        f"{source['label']} (${money(source['price'])})" for source in row["litAlertsSampleSources"]
                    ),
                    "Sample Like": "yes" if row["sampleLike"] else "",
                    "Primary Image Source": row["primaryImageSource"],
                    "Primary Image URL": row["primaryImageUrl"],
                    "Review Flags": " | ".join(row["reviewFlags"]),
                    "Notes": row["notes"],
                }
            )

    action_counts = defaultdict(int)
    category_counts = defaultdict(int)
    for row in payload["rows"]:
        action_counts[row["actionType"]] += 1
        category_counts[row["expectedCategory"]] += 1

    rows = sorted(
        payload["rows"],
        key=lambda row: (
            row["expectedCategory"].lower(),
            (row["expectedSubcategory"] or "").lower(),
            row["targetVariantName"].lower(),
            row["targetBrand"].lower(),
            row["distributorProductName"].lower(),
        ),
    )
    write_detail_pages(rows)
    missing_evidence_count = sum(1 for row in rows if row["litAlertsMatchCount"] == 0)
    thin_evidence_count = sum(1 for row in rows if 0 < row["litAlertsMatchCount"] < 3)
    missing_price_count = sum(1 for row in rows if row["proposedPrice"] is None)
    image_coverage_count = sum(1 for row in rows if row["primaryImageUrl"])

    category_mix = ", ".join(
        f"{category}: {count}" for category, count in sorted(category_counts.items(), key=lambda item: item[0].lower())
    )
    warning_items = [
        f"{missing_evidence_count} row(s) still have no Lit Alerts evidence after the current statewide filter.",
        f"{thin_evidence_count} row(s) only have thin Lit Alerts evidence (<3 matches).",
        f"{missing_price_count} row(s) still need a manual draft price.",
        f"{len(rows) - image_coverage_count} row(s) still have no embedded reviewer image.",
    ]
    order_rows_html = []
    for order in payload["orders"]:
        order_rows_html.append(
            "<tr>"
            f"<td>{order['orderId']}</td>"
            f"<td>{html.escape(order['externalOrderId'])}</td>"
            f"<td>{html.escape(order['distributor'])}</td>"
            f"<td>{html.escape(order['deliveryDate'])}</td>"
            f"<td>{order['positionCount']}</td>"
            f"<td>{order['unresolvedPositionCount']}</td>"
            "</tr>"
        )

    html_text = f"""<!doctype html>
<html lang='en'>
<head>
  <meta charset='utf-8'>
  <title>{PACKET_TITLE}</title>
  <style>
{HTML_STYLE_BLOCK}
  </style>
</head>
<body>
  <div class='wrap'>
    <details class='hero'>
      <summary class='hero-summary'>
        <span class='group-kicker'>Packet Header</span>
        <h1>{PACKET_TITLE}</h1>
        <span class='group-count'>Show packet summary, draft status, and audit scope</span>
      </summary>
      <div class='hero-content'>
        <p class='muted'>Draft proposal-only packet for the active {html.escape(payload['siteContext']['siteLabel'])} outstanding delivered-order queue. Reads happen in the <strong>{html.escape(payload['siteContext']['dealerName'])}</strong> site context for purchase data and the <strong>{html.escape(payload['stateContext']['dealerName'])}</strong> state context for catalog inspection. This HTML is intentionally review-first: every unresolved row stays visible, current evidence gaps stay explicit, and the packet does not perform live catalog writes.</p>
        <p class='muted'>Products are grouped by <strong>Category</strong> -> <strong>Subcategory</strong> -> <strong>Variant name</strong> -> <strong>Brand</strong>. Click any non-link part of a row to open that row's detail page in a new tab.</p>
        <div class='summary-grid'>
          <div class='summary-card'><span class='muted'>Orders</span><strong>{len(payload['orders'])}</strong></div>
          <div class='summary-card'><span class='muted'>Unresolved distributor products</span><strong>{len(rows)}</strong></div>
          <div class='summary-card'><span class='muted'>Catalog-create rows</span><strong>{action_counts['catalog-create']}</strong></div>
          <div class='summary-card'><span class='muted'>Mapping-only rows</span><strong>{action_counts['mapping-only']}</strong></div>
          <div class='summary-card'><span class='muted'>Embedded images</span><strong>{image_coverage_count} / {len(rows)}</strong></div>
        </div>
        <div class='banner-row'>
          <div class='callout danger'>
            <h2>Draft Status</h2>
            <p class='muted'>Treat this packet as a reviewer-facing proposal, not an auto-approval. Any thin evidence, naming ambiguity, placeholder-mapped purchase line, or manual-price flag should be resolved here before any live catalog write pass.</p>
            <ul class='flag-list'>
              {''.join(f'<li>{html.escape(item)}</li>' for item in warning_items)}
            </ul>
          </div>
          <div class='callout'>
            <h2>Audit Scope</h2>
            <div class='audit-grid'>
              <div class='audit-card'><span class='muted'>Site context</span><strong>{html.escape(payload['siteContext']['dealerName'])}</strong></div>
              <div class='audit-card'><span class='muted'>State context</span><strong>{html.escape(payload['stateContext']['dealerName'])}</strong></div>
              <div class='audit-card'><span class='muted'>Generated</span><strong>{html.escape(payload['generatedAt'])}</strong></div>
              <div class='audit-card'><span class='muted'>Category mix</span><strong>{html.escape(category_mix)}</strong></div>
            </div>
          </div>
        </div>
      </div>
    </details>

    <section class='orders-panel panel'>
      <h2>Live Order Scope</h2>
      <p class='muted'>Queue source: <code>store.purchase.order.list</code> from dealer <strong>{html.escape(payload['siteContext']['dealerName'])}</strong> with <code>orderStatusId: 2</code>, <code>fromDate: {ORDER_LIST_FROM_DATE}</code>, and <code>toDate: {ORDER_LIST_TO_DATE}</code>.</p>
      <table class='orders-table'>
        <thead>
          <tr>
            <th>Order</th>
            <th>External ID</th>
            <th>Distributor</th>
            <th>Delivery Date</th>
            <th>Total Positions</th>
            <th>Unresolved Positions</th>
          </tr>
        </thead>
        <tbody>
          {''.join(order_rows_html)}
        </tbody>
      </table>
    </section>

    <section class='packet-groups'>
      {render_grouped_packet(rows)}
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
        if (!details) {{
          return;
        }}
        const targetTop = button.getBoundingClientRect().top;
        const nextDetails = nextCollapsibleAfter(details);
        details.open = false;
        requestAnimationFrame(() => {{
          const anchor = nextDetails || details;
          const anchorTop = anchor.getBoundingClientRect().top;
          window.scrollBy(0, anchorTop - targetTop);
        }});
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
    OUTPUT_HTML_PATH.write_text(html_text)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a pending-order catalog proposal packet for a Sweed site.")
    parser.add_argument(
        "--site",
        choices=sorted(SITE_CONFIGS),
        default="midtown",
        help="Site queue to inspect. Catalog inspection always happens from the Freshly Baked NY state dealer.",
    )
    parser.add_argument(
        "--output-stem",
        help="Optional output filename stem. Defaults to the configured stem for the selected site.",
    )
    return parser.parse_args()


# Distributor product names to drop from the proposal because the operator has
# explicitly chosen to skip them in the current packet (e.g. brand naming or
# catalog target still under discussion). Match is exact on distributorProductName.
SKIP_DISTRIBUTOR_PRODUCT_NAMES: set[str] = set()


def main() -> None:
    args = parse_args()
    configure_runtime(args.site, args.output_stem)
    orders, groups = collect_pending_groups()
    skipped_groups = [g for g in groups if g["distributorProductName"] in SKIP_DISTRIBUTOR_PRODUCT_NAMES]
    if skipped_groups:
        for g in skipped_groups:
            print(
                f"Skipping operator-deferred distributor product {g['distributorProductName']!r} "
                f"(distributorProductId {g['distributorProductId']}, orders {g['orderIds']})"
            )
    groups = [g for g in groups if g["distributorProductName"] not in SKIP_DISTRIBUTOR_PRODUCT_NAMES]
    switch_context(STATE_DEALER_ID, STATE_DEALER_NAME)
    rows = [build_row(group) for group in groups]
    payload = {
        "packetTitle": PACKET_TITLE,
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "siteContext": {
            "siteKey": SITE_KEY,
            "siteLabel": SITE_LABEL,
            "dealerId": SITE_DEALER_ID,
            "dealerName": SITE_DEALER_NAME,
        },
        "stateContext": {"dealerId": STATE_DEALER_ID, "dealerName": STATE_DEALER_NAME},
        "orders": orders,
        "rows": rows,
    }
    write_outputs(payload)
    print(f"Wrote {OUTPUT_JSON_PATH}")
    print(f"Wrote {OUTPUT_CSV_PATH}")
    print(f"Wrote {OUTPUT_HTML_PATH}")
    print(f"Wrote detail pages to {OUTPUT_DETAIL_DIR}")


if __name__ == "__main__":
    main()
