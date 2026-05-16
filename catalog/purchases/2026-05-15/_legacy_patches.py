"""Runtime patches applied to the legacy 2026-04-13 generator so the 2026-05-11
combined pending-purchases packet can produce all rows correctly.

Patches:
  1. `parse_product_name`: consult the pre-warmed Mantle LLM cache before falling
     into legacy regex parsers. Distributor SKUs like `BS Ice Cream Swirl 14g`
     and `MZ Lemon Cherry Gelato Live Rosin Vape .5g` aren't matched by any
     legacy parser and otherwise raise RuntimeError.
  2. `recommended_row_price`: per-brand GM-target override. Default behaviour
     is preserved; brands listed in `BRAND_GM_TARGET_OVERRIDES` price to the
     overridden GM target (computed from cost) regardless of competitor pressure
     so that subsequent marketing promo discounts can land inside the band.

The patches are intentionally additive and explicit so a reviewer can audit
exactly what diverges from the legacy behaviour.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
CACHE_PATH = WORKDIR / "cache" / "llm_parsed.json"
MANIFEST_PATH = WORKDIR / "manifest_10ff.json"

if str(WORKDIR) not in sys.path:
    sys.path.insert(0, str(WORKDIR))

# Per-brand GM-target overrides keyed by canonical brand display name. The
# value is the *target* gross-margin fraction the proposed shelf price should
# achieve given the post-tax revenue model (1.13x cost). The user directive
# (2026-05-11) is to price every brand co-located on the Stop 31 LLC Midtown
# pending order (131845) at the top of the MSO band so the marketing team can
# discount via promos. This includes Herb plus all sibling brands on that
# order.
BRAND_GM_TARGET_OVERRIDES: dict[str, float] = {
    "Herb": 0.675,
    "Doobie Labs": 0.675,
    "Jungle Girl": 0.675,
    "Moonlit Hash Co": 0.675,
    "Preferred Gardens": 0.675,
    "Purps": 0.675,
    "Runtz": 0.675,
    "Smartbud": 0.675,
    "Strain Gang": 0.675,
}

# Canonical brand-display normalization used when matching against the
# override map. Mirrors the LLM parser's brand outputs and the manifest's
# canonical brand spellings.
_BRAND_NORMALIZATION = {
    "herb": "Herb",
    "doobie labs": "Doobie Labs",
    "jungle girl": "Jungle Girl",
    "moonlit": "Moonlit Hash Co",
    "moonlit hash co": "Moonlit Hash Co",
    "preferred gardens": "Preferred Gardens",
    "purps": "Purps",
    "runtz": "Runtz",
    "smartbud": "Smartbud",
    "strain gang": "Strain Gang",
}


def normalize_brand(brand: str | None) -> str:
    if not brand:
        return ""
    key = brand.strip().lower()
    return _BRAND_NORMALIZATION.get(key, brand.strip())


def _load_llm_cache() -> dict[str, dict]:
    if not CACHE_PATH.exists():
        return {}
    try:
        return json.loads(CACHE_PATH.read_text())
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"LLM cache at {CACHE_PATH} is corrupt: {exc}") from exc


def _load_manifest() -> dict[str, dict]:
    """Authoritative override for the Stop 31 / Midtown 10FF Distribution
    pending order. Keyed by `distributorProductName` exactly as it appears
    on the Sweed pending purchase row; values are the canonical decoding
    extracted from the scanned manifest PDF (see `manifest_10ff.json`)."""
    if not MANIFEST_PATH.exists():
        return {}
    try:
        data = json.loads(MANIFEST_PATH.read_text())
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Manifest at {MANIFEST_PATH} is corrupt: {exc}") from exc
    out: dict[str, dict] = {}
    for item in data.get("lineItems", []):
        key = item.get("distributorProductName")
        if not key:
            continue
        out[key] = item
    return out


def _manifest_to_legacy_shape(item: dict, raw_name: str) -> dict:
    brand = item.get("brand") or ""
    if not brand:
        raise RuntimeError(
            f"Manifest entry for {raw_name!r} has no brand"
        )
    group_name = item.get("groupName") or ""
    return {
        "brand": brand,
        "category": item.get("category") or "",
        "subcategory": item.get("subcategory") or "",
        "groupName": group_name,
        "variantTab": item.get("variantTab") or item.get("perUnitSize") or "",
        "variantName": item.get("variantName") or f"{brand} {group_name}".strip(),
        "size": item.get("perUnitSize") or "",
        "packCount": int(item.get("packCount") or 1),
        "searchTerm": item.get("strainName") or group_name or brand,
        "strainName": item.get("strainName") or "",
        "prevalence": None,
        # carry-through breadcrumbs for downstream packet enrichment
        "_metrcTag": item.get("metrcTag"),
        "_manifestProductName": item.get("manifestProductName"),
        "_manifestNotes": item.get("notes"),
        "_manifestWholesalePerUnit": item.get("wholesalePerUnit"),
        "_isInfused": bool(item.get("isInfused")),
        "_isLiveResin": bool(item.get("isLiveResin")),
    }


def _llm_to_legacy_shape(parsed: dict, raw_name: str) -> dict:
    """Map the LLM-parser schema to the contract `g.build_row` expects."""
    brand = parsed.get("brand") or ""
    if not brand:
        raise RuntimeError(
            f"LLM cache entry for {raw_name!r} has no brand; "
            f"rationale: {parsed.get('rationale','')!r}"
        )
    group_name = parsed.get("groupName") or ""
    return {
        "brand": brand,
        "category": parsed.get("category") or "",
        "subcategory": parsed.get("subcategory") or "",
        "groupName": group_name,
        "variantTab": parsed.get("variantTab") or parsed.get("size") or "",
        "variantName": parsed.get("variantName") or f"{brand} {group_name}",
        "size": parsed.get("size") or "",
        "packCount": int(parsed.get("packCount") or 1),
        "searchTerm": parsed.get("strainName") or group_name or brand,
        "strainName": parsed.get("strainName") or "",
        "prevalence": parsed.get("prevalence") or None,
    }


def install_patches(legacy_module) -> None:
    """Wedge the manifest + LLM cache + brand GM override into the legacy
    generator. Resolution order for distributor product names:
      1. `manifest_10ff.json` (authoritative scanned 10FF Distribution manifest;
         supersedes prior LLM guesses for the Stop 31 / Midtown order),
      2. pre-warmed LLM cache (`cache/llm_parsed.json`),
      3. legacy regex parsers in the 2026-04-13 generator.
    """
    manifest = _load_manifest()
    cache = _load_llm_cache()
    original_parse = legacy_module.parse_product_name

    def patched_parse(name: str) -> dict:
        if name in manifest:
            return _manifest_to_legacy_shape(manifest[name], name)
        if name in cache:
            return _llm_to_legacy_shape(cache[name], name)
        return original_parse(name)

    legacy_module.parse_product_name = patched_parse
    # Expose for downstream packet enrichment (METRC tag stamping etc.)
    legacy_module._manifest_overrides = manifest

    original_recommend = legacy_module.recommended_row_price

    POST_TAX_MULTIPLIER = legacy_module.POST_TAX_MULTIPLIER
    round_up_to_half = legacy_module.round_up_to_half
    round_down_to_half = legacy_module.round_down_to_half

    def gm_target_price(cost: float, target_gm: float) -> float:
        # Solve for shelf price P such that GM = 1 - (POST_TAX_MULTIPLIER*cost)/P = target_gm
        # i.e. P = POST_TAX_MULTIPLIER * cost / (1 - target_gm)
        ideal = POST_TAX_MULTIPLIER * cost / (1.0 - target_gm)
        # Snap to a preferred half-dollar ending. Round up so we don't cross
        # under the GM target; if the float ideal already lands on .00/.50,
        # round_up_to_half preserves it.
        return round_up_to_half(ideal)

    # Stash for the row-pricing override pass.
    legacy_module._brand_gm_override = BRAND_GM_TARGET_OVERRIDES
    legacy_module._gm_target_price = gm_target_price
    legacy_module._normalize_brand_for_override = normalize_brand

    # We do NOT monkey-patch recommended_row_price directly; the override is
    # applied in the combined-packet driver after build_row returns, where we
    # have the parsed brand on hand. This keeps the legacy module free of new
    # global behaviour and isolates the override semantics in the new packet.
    print(
        f"[patches] manifest overrides: {len(manifest)}; "
        f"LLM cache entries available: {len(cache)}; "
        f"brand GM overrides: {list(BRAND_GM_TARGET_OVERRIDES.keys())}",
        flush=True,
    )


def apply_brand_gm_override(row: dict, legacy_module) -> dict:
    """Recompute proposedPrice / GM% for a row whose brand is listed in
    BRAND_GM_TARGET_OVERRIDES. Mutates the row in place and returns it."""
    brand = normalize_brand(row.get("targetBrand"))
    target_gm = BRAND_GM_TARGET_OVERRIDES.get(brand)
    cost = row.get("effectiveUnitCost")
    if target_gm is None or cost is None or cost <= 0:
        return row

    original_price = row.get("proposedPrice")
    new_price = legacy_module._gm_target_price(float(cost), float(target_gm))

    row["proposedPrice"] = new_price
    row["gmPercent"] = legacy_module.gm_percent(cost, new_price)
    row["pricingAction"] = legacy_module.classify_pricing_action(
        row.get("currentPrice"), new_price
    )
    note = (
        f"Brand GM-target override: {brand} priced to {target_gm * 100:.1f}% GM "
        f"(top of MSO band) per Stop 31 LLC purchase order directive 2026-05-11; "
        f"marketing will discount via promos rather than charging the full shelf "
        f"price out of the box."
    )
    if original_price is not None and abs(float(original_price) - new_price) > 0.01:
        note += f" Pre-override draft was ${float(original_price):.2f}."
    existing_reason = row.get("pricingReason") or ""
    row["pricingReason"] = (note + " " + existing_reason).strip()

    flags = list(row.get("reviewFlags") or [])
    if "Brand GM-target override applied" not in flags:
        flags.append("Brand GM-target override applied")
    row["reviewFlags"] = flags

    # Recompute the price ladder domain so the draggable proposed marker has
    # room to land.
    domain_inputs = [
        row.get("currentPrice"),
        new_price,
        row.get("averageCompetitorPostTaxPrice"),
        row.get("competitorMinPostTaxPrice"),
        row.get("competitorMaxPostTaxPrice"),
    ]
    pmin, pmax = legacy_module.pricing_domain_bounds(domain_inputs)
    row["pricingDomainMin"] = pmin
    row["pricingDomainMax"] = pmax

    return row
