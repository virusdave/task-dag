"""Mantle-backed distributor-product-name parser with on-disk cache.

The legacy `categories/2026-04-13/generate_pending_order_catalog_proposal.py`
parser is a tower of hand-coded brand-prefix branches and silently routes
unknown shapes into the HR Botanical fallback (which then `RuntimeError`s on
unhandled cultivar text). For the canonical "produce pending purchases
proposal" workflow recorded in
`docs/sweed/catalog/produce-pending-purchase-proposal.md`, the parser must
succeed for every row in scope and must not swallow failures.

This module:

- sends the raw distributor-product name (plus optional context such as the
  distributor company name and any sibling line items) to Mantle
  `google.gemma-3-27b-it`,
- requires a strict JSON object back, schema-validates it, and raises loudly
  on any deviation,
- caches the validated result by raw distributor-product name in
  `cache/llm_parsed.json` so reruns are deterministic and free.

The returned schema mirrors the `parse_product_name` contract used by
`build_row` in the legacy generator so existing pricing / image / row code
can consume it unchanged.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

WORKDIR = Path(__file__).resolve().parent
CACHE_DIR = WORKDIR / "cache"
CACHE_PATH = CACHE_DIR / "llm_parsed.json"

MANTLE_BEARER_PATH = Path("/Users/amp-local/.secret/bedrock/mantle-bearer-token")
MANTLE_ENDPOINT = "https://bedrock-mantle.us-east-2.api.aws/v1/chat/completions"
MANTLE_MODEL = "google.gemma-3-27b-it"

REQUIRED_FIELDS = (
    "brand",
    "category",
    "subcategory",
    "groupName",
    "variantName",
    "variantTab",
    "size",
    "packCount",
    "isInfused",
    "isLiveResin",
    "strainName",
    "prevalence",
    "rationale",
)

ALLOWED_CATEGORIES = {
    "Flower",
    "Pre-Rolls",
    "Vapes",
    "Edibles",
    "Concentrates",
    "Beverages",
    "Tinctures",
    "Topicals",
    "Accessories",
    "Other",
}

ALLOWED_PREVALENCES = {
    "Indica",
    "Indica Dominant",
    "Sativa",
    "Sativa Dominant",
    "Hybrid",
    "CBD",
    "CBG",
    "CBN",
    "",
}

PROMPT_SYSTEM = """You are a strict JSON parser for cannabis distributor product names from a New York adult-use Sweed POS catalog. Decompose the raw distributor-product name (and optional context) into structured catalog fields. Always return a single JSON object only - no commentary, no markdown, no code fences.

Field schema (all required):
- brand: canonical brand display name. Distributor SKUs frequently use letter prefixes:
  - "BS" -> "Booty Shake"
  - "J&H" -> "Dr Jekyll and Mr High"
  - "MZ" -> "Moony's Zooties"
  - "PURPS-" -> "Purps"
  - "R-" -> "Runtz"
  - "1O-..." (any internal token) -> "Herb"
  - "Herb -" or "HERB " -> "Herb"
  - "DOOBIE LABS -" -> "Doobie Labs"
  - "Jungle Girl -" -> "Jungle Girl"
  - "MOONLIT-" or "MOONLIT-" -> "Moonlit"
  - "SMARTBUD" -> "Smartbud"
  - "STRAIN GANG-" -> "Strain Gang"
  - "MFNY " -> "MFNY"
  - "APE |" -> "APE"
  Use the canonical brand name; never echo the prefix.
- category: one of Flower, Pre-Rolls, Vapes, Edibles, Concentrates, Beverages, Tinctures, Topicals, Accessories, Other.
- subcategory: For Flower use "Pre-Packaged Flower"; for Vapes 510 carts use "Cartridge", for live resin/rosin vape carts use "Live Resin Cartridge", for all-in-one disposables "All In One / Disposable"; for Pre-Rolls multipacks use "Multi-Pack", for infused single prerolls "Infused", for plain single prerolls "" (empty).
- groupName: the cultivar / strain / product-family name. Resolve abbreviations to the full cultivar name when possible (e.g. "GDP" -> "Granddaddy Purple", "BLDR" -> "Boulder", "PNCH" -> "Punch", "SCND" -> "Sundae Driver", "BNRD" -> "Bonkerz", "OISH" -> "Oishi", "RGB" -> "Rainbow Belts", "TRP" -> "Tropicana", "KNGL" -> "Kingsbread", "CKD" -> "Cookies", "ZRZ" -> "Zerz", "PGSH" -> "Pink Gushers", "DBUR" -> "Donny Burger", "SDSL" -> "Sour Diesel", "WIOG" -> "WiFi OG"). For infused vs non-infused versions of the same cultivar, INCLUDE "Infused" in the groupName when isInfused=true so the two variants don't collide (e.g. "MAC1 Infused" vs "MAC1").
- variantTab: the canonical Sweed variant label. Singles use the unit size like "1g", "3.5g", "14g", "0.5g". Multipacks use "Nx UNITSIZE" like "5x 0.35g", "7x 0.5g", "4x 0.75g". Always use a numeric per-unit size; never the literal token "UNITSIZE".
- variantName: brand-prefixed full variant label, e.g. "Booty Shake Ice Cream Swirl 14g" or "Moony's Zooties Blue Zushi 7x 0.5g". Multipack variant names must include the "Nx PERUNIT" form, not "NPk" or "5pk".
- size: the per-unit size including unit (e.g. "1g", "0.5g", "3.5g", "14g", "100mg"). Use a leading zero on fractional grams (".5g" -> "0.5g").
- packCount: integer count of units in the package; 1 for singles. Must match the SKU literal: "5pk"/"5PR"/"5 Pack"/"5-Pack" -> 5; "7Pk"/"7-Pack" -> 7; "4x"/"4 pk" -> 4; "2pk" -> 2; otherwise 1.
- isInfused: true if the SKU is an infused preroll, hash hole, or live-resin/rosin-coated preroll. Inputs containing "INFUSED", "Infused PR", "Hash Hole", "live resin infused", or "live rosin infused" are infused. "Non-Infused" is explicitly NOT infused.
- isLiveResin: true if the SKU explicitly contains "Live Resin" or "Live Rosin", otherwise false.
- strainName: cultivar name for the Sweed strain dictionary. Use the resolved full cultivar (no infused/format suffix). For multipack assortments with no single cultivar, use "".
- prevalence: one of Indica, Indica Dominant, Sativa, Sativa Dominant, Hybrid, CBD, CBG, CBN, or "" if unknown.
- rationale: 1-3 sentences explaining how you decoded the prefix, the size, the pack count, and the cultivar. Mention any abbreviation expansions you used.

Strict size/pack rules - violations are bugs:
- "1/2oz", "1/2 oz", "Half Ounce" -> 14g per unit.
- "1/8", "1/8 oz", "Eighth", "3.5g", "3.5G" -> 3.5g per unit.
- "1/4", "1/4 oz", "Quarter" -> 7g per unit.
- "1g", "1G", ".5g", "0.5g", "1.2g", "1.2G", "0.75g", "0.35g" -> exactly that per unit (use leading zero).
- "8F" anywhere in a "1O-..." Herb code means EIGHTH OF FLOWER -> 3.5g flower per unit (NOT 14g).
- "5F" in a "1O-..." code means HALF-OUNCE FLOWER -> 14g flower per unit.
- "5PR" or "PR5" in a Herb-style code means 5-pack of 1g prerolls -> packCount=5, size="1g", variantTab="5x 1g".
- "PR32" in a Herb-style code means a 32-count blunt-style preroll multi-pack -> packCount=32, size="0.5g", variantTab="32x 0.5g". If you are unsure of the per-unit size for an unfamiliar PR<N> code, set brand to null and explain in rationale rather than guessing.
- "7Pk Pre-Roll" with no per-unit size given is a 7-pack of 0.5g prerolls totaling 3.5g -> packCount=7, size="0.5g", variantTab="7x 0.5g".
- "4 pk" with ".75g" given is packCount=4, size="0.75g", variantTab="4x 0.75g".

Cultivar / format rules:
- For Vape product names like "Lemon Cherry Gelato Live Rosin Vape .5g", strainName is the cultivar only ("Lemon Cherry Gelato"); category="Vapes"; subcategory="Live Resin Cartridge" if Live Resin/Rosin else "Cartridge"; size="0.5g"; isLiveResin=true.
- For prerolls labeled "Infused PR" / "Infused 1g": category="Pre-Rolls", subcategory="Infused", isInfused=true; the brand+cultivar+"Infused" should appear in variantName so it does not collide with a same-cultivar non-infused variant.
- For Moonlit "MAC1 INFUSED 1.2G" vs "MAC1 Non-Infused 1.2G", emit DIFFERENT groupName values ("MAC1 Infused" vs "MAC1") and different variantName values; same cultivar in two variants is a name collision and is wrong.

Output rules:
- Output exactly one JSON object with all fields above and no extras.
- Never include the literal token "UNITSIZE" or "<...>" or "TODO" or "?" in any field.
- Use the brand's official capitalization (e.g. "Moony's Zooties", "Herb", "Booty Shake", "Dr Jekyll and Mr High", "Field of Dreams", "Smartbud", "Moonlit", "Doobie Labs", "Strain Gang", "Purps", "Runtz", "Jungle Girl").
- If you cannot confidently identify the brand from prefix + context, OR cannot resolve a concrete numeric per-unit size, set brand to null and explain in rationale; the calling code will treat null brand as a hard error and surface it for human review."""


def _force_ipv4_once() -> None:
    original = socket.getaddrinfo

    def _ipv4_only(*args, **kwargs):
        return [info for info in original(*args, **kwargs) if info[0] == socket.AF_INET]

    socket.getaddrinfo = _ipv4_only


_force_ipv4_once()


def _load_cache() -> dict[str, Any]:
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text())
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"LLM-parser cache at {CACHE_PATH} is corrupt: {exc}. "
                "Inspect or delete it manually rather than letting the pass silently retry."
            ) from exc
    return {}


def _save_cache(cache: dict[str, Any]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n")


def _mantle_chat(messages: list[dict], temperature: float = 0.0, max_tokens: int = 1024) -> str:
    if not MANTLE_BEARER_PATH.exists():
        raise RuntimeError(
            f"Mantle bearer token missing at {MANTLE_BEARER_PATH}. Refresh per "
            "docs/private-llm/access-paths-and-secrets.md before retrying."
        )
    token = MANTLE_BEARER_PATH.read_text().strip()
    if not token:
        raise RuntimeError(f"Mantle bearer token at {MANTLE_BEARER_PATH} is empty.")

    body = json.dumps(
        {
            "model": MANTLE_MODEL,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        MANTLE_ENDPOINT,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "Mozilla/5.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Mantle chat completion failed with HTTP {exc.code}: {detail[:300]}"
        ) from exc

    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError(
            f"Mantle returned no choices: {json.dumps(payload, sort_keys=True)[:300]}"
        )
    content = (choices[0].get("message") or {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError(
            f"Mantle returned empty content: {json.dumps(payload, sort_keys=True)[:300]}"
        )
    return content.strip()


def _strict_json(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        # Strip ```json fences if the model added them despite instructions.
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Mantle parser returned non-JSON content: {content[:400]!r}"
        ) from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(
            f"Mantle parser returned non-object JSON: {content[:400]!r}"
        )
    return parsed


def _validate(parsed: dict[str, Any], raw_name: str) -> dict[str, Any]:
    missing = [field for field in REQUIRED_FIELDS if field not in parsed]
    if missing:
        raise RuntimeError(
            f"Mantle parser missing required fields {missing} for {raw_name!r}: "
            f"{json.dumps(parsed, sort_keys=True)[:400]}"
        )
    if parsed["brand"] is None:
        raise RuntimeError(
            f"Mantle parser could not identify a brand for {raw_name!r}; "
            f"rationale: {parsed.get('rationale', '')!r}. Surface for human review."
        )
    if parsed["category"] not in ALLOWED_CATEGORIES:
        raise RuntimeError(
            f"Mantle parser returned unknown category {parsed['category']!r} for {raw_name!r}."
        )
    if parsed["prevalence"] not in ALLOWED_PREVALENCES:
        raise RuntimeError(
            f"Mantle parser returned unknown prevalence {parsed['prevalence']!r} for {raw_name!r}."
        )
    if not isinstance(parsed["packCount"], int) or parsed["packCount"] < 1:
        raise RuntimeError(
            f"Mantle parser returned invalid packCount {parsed['packCount']!r} for {raw_name!r}."
        )
    forbidden_substrings = ("UNITSIZE", "<", "TODO", "????")
    for field in ("variantTab", "variantName", "size", "groupName"):
        value = parsed.get(field)
        if not isinstance(value, str) or not value.strip():
            raise RuntimeError(
                f"Mantle parser returned empty {field!r} for {raw_name!r}."
            )
        for bad in forbidden_substrings:
            if bad in value:
                raise RuntimeError(
                    f"Mantle parser left placeholder {bad!r} in {field}={value!r} "
                    f"for {raw_name!r}; rationale: {parsed.get('rationale','')!r}."
                )
    if parsed["packCount"] > 1:
        expected_prefix = f"{parsed['packCount']}x "
        if not parsed["variantTab"].startswith(expected_prefix):
            raise RuntimeError(
                f"Mantle parser returned packCount={parsed['packCount']} but "
                f"variantTab={parsed['variantTab']!r} does not match the canonical "
                f"'Nx UNITSIZE' shape for {raw_name!r}."
            )
    return parsed


def parse_distributor_product_name(
    raw_name: str,
    distributor_company: str | None = None,
    sibling_names: list[str] | None = None,
) -> dict[str, Any]:
    """Parse one distributor product name to the catalog schema. Cached on
    raw_name; raises loudly on any failure."""
    cache = _load_cache()
    cached = cache.get(raw_name)
    if isinstance(cached, dict) and "brand" in cached and cached.get("brand"):
        return cached

    user_lines: list[str] = [
        f"distributor company: {distributor_company or 'unknown'}",
        f"raw distributor product name: {raw_name!r}",
    ]
    if sibling_names:
        user_lines.append(
            "sibling line items on the same purchase order (use as context, do not echo):"
        )
        for sib in sibling_names:
            if sib != raw_name:
                user_lines.append(f"  - {sib!r}")

    messages = [
        {"role": "system", "content": PROMPT_SYSTEM},
        {"role": "user", "content": "\n".join(user_lines)},
    ]

    content = _mantle_chat(messages)
    parsed = _validate(_strict_json(content), raw_name)
    cache[raw_name] = parsed
    _save_cache(cache)
    return parsed


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: llm_parser.py <distributor-product-name> [distributor-company]", file=sys.stderr)
        return 2
    name = sys.argv[1]
    company = sys.argv[2] if len(sys.argv) > 2 else None
    print(json.dumps(parse_distributor_product_name(name, company), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
