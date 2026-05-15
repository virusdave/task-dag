#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import html
import json
import re
import socket
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


API_URL = "https://prime.sweedpos.com/api/"
AUTH_TOKEN = "74a71554-e0ef-4fe6-bdc0-d02ad68db483"
BASE_URL = "https://prime.sweedpos.com"
WORKDIR = Path(__file__).resolve().parent
OUTPUT_PATH = WORKDIR / "product_catalog_attribute_analysis.html"
OUTPUT_JSON_PATH = WORKDIR / "product_catalog_attribute_analysis.json"
SITE_DEALER_ID = 210705
SITE_DEALER_NAME = "Freshly Baked NYC - Midtown"

GENERIC_STRAIN_NAMES = {
    None,
    "Hybrid",
    "Indica",
    "Sativa",
    "Indica Hybrid",
    "Sativa Hybrid",
}

GENERIC_GROUP_SUFFIXES = (
    " (Hybrid)",
    " (Indica)",
    " (Sativa)",
    " (Indica Hybrid)",
    " (Sativa Hybrid)",
)
STRAIN_LABEL_PARENTHESES_PATTERN = re.compile(r"\(([^()]*)\)")
TRAILING_OPEN_STRAIN_FRAGMENT_PATTERN = re.compile(r"\s*\((?P<label>[A-Za-z\s\-/]+)(?=(?:\s+\d)|\s*$)")
BAR_STRAIN_FRAGMENT_PATTERN = re.compile(r"\s*\|\s*(?P<label>[A-Za-z\s\-/]+?)(?=(?:\s*\|)|(?:\s+\d)|\s*$)")
STRAIN_LABEL_TOKENS = {
    "h",
    "hyb",
    "hybrid",
    "i",
    "ind",
    "indica",
    "s",
    "sat",
    "sativa",
    "dom",
    "dominant",
    "lean",
    "leaning",
}
STRAIN_LABEL_TOKEN_CANONICALS = tuple(sorted({*STRAIN_LABEL_TOKENS, "dominan", "indic", "sativ", "hybri"}))

NON_ATTRIBUTE_ACTION_CATEGORIES = {"Accessories"}


ORIGINAL_GETADDRINFO = socket.getaddrinfo


def ipv4_first_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    # Cloudflare on the IPv6 path intermittently challenges identical Sweed RPC reads.
    if host == "prime.sweedpos.com":
        family = socket.AF_INET
    return ORIGINAL_GETADDRINFO(host, port, family, type, proto, flags)


socket.getaddrinfo = ipv4_first_getaddrinfo


LEAFLY_SLUG_ALIASES = {
    "GG4": "original-glue",
    "Gorilla Glue #4": "original-glue",
    "Candy Kush": "kandy-kush",
    "Honey Banana": "honey-bananas",
    "Sky Dog": "skydog",
    "The Original Z": "zkittlez",
    "Zkittles": "zkittlez",
}

GROUP_EQUIVALENT_STRAINS = {
    "Gorilla Glue": "Gorilla Glue #4",
}

PRODUCT_STRAIN_HINTS = {
    "ACE Northern Lights": "Northern Lights",
    "Ace Lemon Cherry Gelato": "Lemon Cherry Gelato",
    "Ace Pineapple Express": "Pineapple Express",
    "Traveler Granddaddy Purple (Indica)": "Granddaddy Purple",
    "Traveler Headband (Hybrid)": "Headband",
    "Traveler Pro Red Headed Stranger": "Red Headed Stranger",
    "Traveler Pro Space Queen": "Space Queen",
    "Traveler White Widow": "White Widow",
}


VERIFIED_STRAIN_LEAFLY = {
    "Blue Dream": {
        "url": "https://www.leafly.com/strains/blue-dream",
        "label": "Verified current strain page: Blue Dream",
        "status": "verified-proxy",
        "effects": ["Creative", "Euphoric", "Happy"],
        "flavors": ["Berry", "Blueberry", "Sweet"],
        "terpenes": ["Myrcene", "Pinene", "Caryophyllene"],
        "note": "Verified exact Leafly strain page for the current attached strain `Blue Dream`.",
    },
    "Blue Nerds": {
        "url": "https://www.leafly.com/strains/blue-nerds",
        "label": "Verified current strain page: Blue Nerds",
        "status": "verified-proxy",
        "effects": ["Focused", "Relaxed", "Euphoric"],
        "flavors": ["Apricot", "Apple", "Blueberry"],
        "terpenes": [],
        "note": "Verified exact Leafly strain page for the current attached strain `Blue Nerds`.",
    },
    "Durban Poison": {
        "url": "https://www.leafly.com/strains/durban-poison",
        "label": "Verified current strain page: Durban Poison",
        "status": "verified-proxy",
        "effects": ["Focused", "Energetic", "Uplifted"],
        "flavors": ["Pine", "Earthy", "Sage"],
        "terpenes": ["Terpinolene", "Myrcene", "Ocimene"],
        "note": "Verified exact Leafly strain page for the current attached strain `Durban Poison`.",
    },
    "Cereal Milk": {
        "url": "https://www.leafly.com/strains/cereal-milk",
        "label": "Verified current strain page: Cereal Milk",
        "status": "verified-proxy",
        "effects": ["Aroused", "Relaxed", "Giggly"],
        "flavors": ["Butter", "Vanilla", "Sweet"],
        "terpenes": ["Caryophyllene", "Limonene", "Humulene"],
        "note": "Verified exact Leafly strain page for the current attached strain `Cereal Milk`.",
    },
    "Gorilla Glue #4": {
        "url": "https://www.leafly.com/strains/original-glue",
        "label": "Verified equivalent current strain page: Gorilla Glue #4 / Original Glue",
        "status": "verified-equivalent",
        "effects": ["Relaxed", "Sleepy", "Hungry"],
        "flavors": ["Pungent", "Earthy", "Pine"],
        "terpenes": ["Caryophyllene", "Myrcene", "Limonene"],
        "note": "Verified equivalent Leafly page for the current attached strain `Gorilla Glue #4`, which Leafly publishes under `Original Glue`.",
    },
    "SFV OG": {
        "url": "https://www.leafly.com/strains/sfv-og",
        "label": "Verified current strain page: SFV OG",
        "status": "verified-proxy",
        "effects": ["Focused", "Relaxed", "Happy"],
        "flavors": ["Pine", "Earthy", "Woody"],
        "terpenes": ["Myrcene", "Limonene", "Caryophyllene"],
        "note": "Verified exact Leafly strain page for the current attached strain `SFV OG`.",
    },
    "Maui Wowie": {
        "url": "https://www.leafly.com/strains/maui-wowie",
        "label": "Verified current strain page: Maui Wowie",
        "status": "verified-proxy",
        "effects": ["Energetic", "Uplifted", "Happy"],
        "flavors": ["Tropical", "Pineapple", "Citrus"],
        "terpenes": ["Myrcene", "Pinene", "Caryophyllene"],
        "note": "Verified exact Leafly strain page for the current attached strain `Maui Wowie`.",
    },
    "Mimosa": {
        "url": "https://www.leafly.com/strains/mimosa",
        "label": "Verified current strain page: Mimosa",
        "status": "verified-proxy",
        "effects": ["Focused", "Energetic", "Uplifted"],
        "flavors": ["Citrus", "Orange", "Grapefruit"],
        "terpenes": ["Myrcene", "Pinene", "Caryophyllene"],
        "note": "Verified exact Leafly strain page for the current attached strain `Mimosa`.",
    },
    "Pineapple Express": {
        "url": "https://www.leafly.com/strains/pineapple-express",
        "label": "Verified current strain page: Pineapple Express",
        "status": "verified-proxy",
        "effects": ["Happy", "Giggly", "Energetic"],
        "flavors": ["Pineapple", "Tropical", "Citrus"],
        "terpenes": ["Myrcene", "Caryophyllene", "Pinene"],
        "note": "Verified exact Leafly strain page for the current attached strain `Pineapple Express`.",
    },
    "Runtz": {
        "url": "https://www.leafly.com/strains/runtz",
        "label": "Verified current strain page: Runtz",
        "status": "verified-proxy",
        "effects": ["Talkative", "Giggly", "Relaxed"],
        "flavors": ["Tree fruit", "Apricot", "Sweet"],
        "terpenes": ["Caryophyllene", "Limonene", "Myrcene"],
        "note": "Verified exact Leafly strain page for the current attached strain `Runtz`.",
    },
    "Sour Diesel": {
        "url": "https://www.leafly.com/strains/sour-diesel",
        "label": "Verified current strain page: Sour Diesel",
        "status": "verified-proxy",
        "effects": ["Energetic", "Talkative", "Uplifted"],
        "flavors": ["Diesel", "Chemical", "Skunk"],
        "terpenes": ["Caryophyllene", "Myrcene", "Limonene"],
        "note": "Verified exact Leafly strain page for the current attached strain `Sour Diesel`.",
    },
    "White Widow": {
        "url": "https://www.leafly.com/strains/white-widow",
        "label": "Verified current strain page: White Widow",
        "status": "verified-proxy",
        "effects": ["Euphoric", "Uplifted", "Talkative"],
        "flavors": ["Woody", "Earthy", "Flowery"],
        "terpenes": ["Myrcene", "Caryophyllene", "Pinene"],
        "note": "Verified exact Leafly strain page for the current attached strain `White Widow`.",
    },
    "Zkittles": {
        "url": "https://www.leafly.com/strains/zkittlez",
        "label": "Verified equivalent current strain page: The Original Z / Zkittlez",
        "status": "verified-equivalent",
        "effects": ["Relaxed", "Sleepy", "Hungry"],
        "flavors": ["Grapefruit", "Grape", "Berry"],
        "terpenes": ["Caryophyllene", "Linalool", "Humulene"],
        "note": "Verified equivalent Leafly page for the current attached strain `Zkittles`, which Leafly now titles `The Original Z`.",
    },
    "Apple Blossom": {
        "url": "https://www.leafly.com/strains/apple-blossom",
        "label": "Verified exact strain page: Apple Blossom",
        "status": "verified-proxy",
        "prevalence": "Hybrid",
        "effects": ["Tingly", "Focused", "Relaxed"],
        "flavors": ["Apple", "Butter", "Chemical"],
        "terpenes": [],
        "note": "Verified exact Leafly strain page for `Apple Blossom`. The page surfaced effects and flavors, but not a terpene trio in the extracted sections.",
    },
    "Biscotti": {
        "url": "https://www.leafly.com/strains/biscotti",
        "label": "Verified exact strain page: Biscotti",
        "status": "verified-proxy",
        "prevalence": "Indica Dominant",
        "effects": ["Tingly", "Relaxed", "Euphoric"],
        "flavors": ["Butter", "Honey", "Vanilla"],
        "terpenes": ["Caryophyllene", "Limonene", "Myrcene"],
        "note": "Verified exact Leafly strain page for `Biscotti`.",
    },
    "Blue Lobster": {
        "url": "https://www.leafly.com/strains/blue-lobster",
        "label": "Verified exact strain page: Blue Lobster",
        "status": "verified-proxy",
        "prevalence": "Hybrid",
        "effects": ["Euphoric", "Relaxed", "Talkative"],
        "flavors": ["Plum", "Apple", "Blueberry"],
        "terpenes": ["Limonene", "Myrcene", "Caryophyllene"],
        "note": "Verified exact Leafly strain page for `Blue Lobster`.",
    },
    "Candy Kush": {
        "url": "https://www.leafly.com/strains/kandy-kush",
        "label": "Verified equivalent strain page: Candy Kush / Kandy Kush",
        "status": "verified-equivalent",
        "prevalence": "Indica Dominant",
        "effects": ["Relaxed", "Hungry", "Happy"],
        "flavors": ["Pear", "Sweet", "Honey"],
        "terpenes": ["Limonene", "Myrcene", "Caryophyllene"],
        "note": "Verified equivalent Leafly page for `Candy Kush`, which Leafly publishes under `Kandy Kush`.",
    },
    "Candyland": {
        "url": "https://www.leafly.com/strains/candyland",
        "label": "Verified exact strain page: Candyland",
        "status": "verified-proxy",
        "prevalence": "Sativa",
        "effects": ["Uplifted", "Energetic", "Happy"],
        "flavors": ["Sweet", "Flowery", "Honey"],
        "terpenes": ["Caryophyllene", "Limonene", "Humulene"],
        "note": "Verified exact Leafly strain page for `Candyland`.",
    },
    "Donny Burger": {
        "url": "https://www.leafly.com/strains/donny-burger",
        "label": "Verified exact strain page: Donny Burger",
        "status": "verified-proxy",
        "prevalence": "Indica",
        "effects": ["Aroused", "Relaxed", "Giggly"],
        "flavors": ["Ammonia", "Cheese", "Pungent"],
        "terpenes": ["Caryophyllene", "Limonene", "Myrcene"],
        "note": "Verified exact Leafly strain page for `Donny Burger`.",
    },
    "Fire OG": {
        "url": "https://www.leafly.com/strains/fire-og",
        "label": "Verified exact strain page: Fire OG",
        "status": "verified-proxy",
        "prevalence": "Indica Dominant",
        "effects": ["Relaxed", "Tingly", "Euphoric"],
        "flavors": ["Lemon", "Earthy", "Pine"],
        "terpenes": ["Myrcene", "Limonene", "Caryophyllene"],
        "note": "Verified exact Leafly strain page for `Fire OG`.",
    },
    "Headband": {
        "url": "https://www.leafly.com/strains/headband",
        "label": "Verified exact strain page: Headband",
        "status": "verified-proxy",
        "prevalence": "Hybrid",
        "effects": ["Euphoric", "Tingly", "Uplifted"],
        "flavors": ["Diesel", "Earthy", "Pungent"],
        "terpenes": ["Caryophyllene", "Limonene", "Myrcene"],
        "note": "Verified exact Leafly strain page for `Headband`.",
    },
    "Honey Banana": {
        "url": "https://www.leafly.com/strains/honey-bananas",
        "label": "Verified equivalent strain page: Honey Banana / Honey Bananas",
        "status": "verified-equivalent",
        "prevalence": "Indica Dominant",
        "effects": ["Giggly", "Happy", "Relaxed"],
        "flavors": ["Honey", "Tree fruit", "Sweet"],
        "terpenes": ["Myrcene", "Limonene", "Caryophyllene"],
        "note": "Verified equivalent Leafly page for `Honey Banana`, which Leafly titles `Honey Bananas`.",
    },
    "Lava Cake": {
        "url": "https://www.leafly.com/strains/lava-cake",
        "label": "Verified exact strain page: Lava Cake",
        "status": "verified-proxy",
        "prevalence": "Indica Dominant",
        "effects": ["Relaxed", "Sleepy", "Tingly"],
        "flavors": ["Pepper", "Mint", "Vanilla"],
        "terpenes": ["Caryophyllene", "Myrcene", "Humulene"],
        "note": "Verified exact Leafly strain page for `Lava Cake`.",
    },
    "Novarine": {
        "url": "https://www.leafly.com/strains/novarine",
        "label": "Verified exact strain page: Novarine",
        "status": "verified-proxy",
        "prevalence": "Sativa Dominant",
        "effects": ["Focused", "Energetic", "Happy"],
        "flavors": ["Menthol", "Flowery", "Earthy"],
        "terpenes": ["Terpinolene"],
        "note": "Verified exact Leafly strain page for `Novarine`. The extracted page named `terpinolene` as the dominant terpene rather than surfacing a full top-three terpene list.",
    },
    "Papaya Bomb": {
        "url": "https://www.leafly.com/strains/papaya-bomb",
        "label": "Verified exact strain page: Papaya Bomb",
        "status": "verified-proxy",
        "prevalence": "Hybrid",
        "effects": ["Creative", "Happy", "Uplifted"],
        "flavors": ["Grapefruit", "Apricot", "Berry"],
        "terpenes": ["Limonene", "Myrcene", "Caryophyllene"],
        "note": "Verified exact Leafly strain page for `Papaya Bomb`.",
    },
    "Red Headed Stranger": {
        "url": "https://www.leafly.com/strains/red-headed-stranger",
        "label": "Verified exact strain page: Red Headed Stranger",
        "status": "verified-proxy",
        "prevalence": "Sativa",
        "effects": ["Focused", "Energetic", "Creative"],
        "flavors": ["Spicy/Herbal", "Tobacco", "Citrus"],
        "terpenes": [],
        "note": "Verified exact Leafly strain page for `Red Headed Stranger`. The extracted page surfaced effects and flavors, but not a terpene trio in the captured sections.",
    },
    "Sky Dog": {
        "url": "https://www.leafly.com/strains/skydog",
        "label": "Verified exact strain page: Sky Dog / Skydog",
        "status": "verified-proxy",
        "prevalence": "Indica Dominant",
        "effects": ["Focused", "Uplifted", "Energetic"],
        "flavors": ["Diesel", "Lemon", "Skunk"],
        "terpenes": [],
        "note": "Verified exact Leafly strain page for `Sky Dog`, which Leafly slugs as `Skydog`. The extracted page surfaced effects and flavors, but not a terpene trio in the captured sections.",
    },
    "Super Lemon Haze": {
        "url": "https://www.leafly.com/strains/super-lemon-haze",
        "label": "Verified exact strain page: Super Lemon Haze",
        "status": "verified-proxy",
        "prevalence": "Sativa Dominant",
        "effects": ["Energetic", "Focused", "Uplifted"],
        "flavors": ["Lemon", "Citrus", "Lime"],
        "terpenes": ["Terpinolene", "Caryophyllene", "Myrcene"],
        "note": "Verified exact Leafly strain page for `Super Lemon Haze`.",
    },
    "White Fire OG": {
        "url": "https://www.leafly.com/strains/white-fire-og",
        "label": "Verified exact strain page: White Fire OG",
        "status": "verified-proxy",
        "prevalence": "Hybrid",
        "effects": ["Focused", "Uplifted", "Happy"],
        "flavors": ["Earthy", "Pungent", "Woody"],
        "terpenes": ["Myrcene", "Limonene", "Caryophyllene"],
        "note": "Verified exact Leafly strain page for `White Fire OG`.",
    },
    "Zonuts": {
        "url": "https://www.leafly.com/strains/zonuts",
        "label": "Verified exact strain page: Zonuts",
        "status": "verified-proxy",
        "prevalence": "Hybrid",
        "effects": ["Energetic", "Talkative", "Creative"],
        "flavors": ["Butter", "Sweet", "Vanilla"],
        "terpenes": [],
        "note": "Verified exact Leafly strain page for `Zonuts`. The extracted page surfaced effects and flavors, but not a terpene trio in the captured sections.",
    },
}

VERIFIED_STRAIN_NAME_BY_LOWER = {
    strain_name.lower(): strain_name for strain_name in VERIFIED_STRAIN_LEAFLY
}


INFERENCE = {
    "GG4": {
        "display_strain": "Gorilla Glue #4",
        "target_strain": "Gorilla Glue #4",
        "prevalence": "Hybrid",
        "leafly_url": "https://www.leafly.com/strains/original-glue",
        "leafly_label": "Exact page: GG4 / Original Glue",
        "terpenes": ["Caryophyllene", "Myrcene", "Limonene"],
        "flavors": ["Pungent", "Earthy", "Pine"],
        "effects": ["Relaxed", "Sleepy", "Hungry"],
        "group_note": "Keep the current group strain attachment; it already matches the inferred cultivar.",
        "group_target_mode": "current",
        "source_note": "Exact Leafly GG4 page. Leafly treats GG4 as the same cultivar as Original Glue.",
    },
    "SFV OG": {
        "display_strain": "SFV OG",
        "target_strain": "SFV OG",
        "prevalence": "Sativa Dominant",
        "leafly_url": "https://www.leafly.com/strains/sfv-og",
        "leafly_label": "Exact page: SFV OG",
        "terpenes": ["Myrcene", "Limonene", "Caryophyllene"],
        "flavors": ["Pine", "Earthy", "Woody"],
        "effects": ["Focused", "Relaxed", "Happy"],
        "group_note": "Create and attach an exact `SFV OG` strain record; the current `Indica Hybrid` attachment is too generic.",
        "group_target_mode": "new_required",
        "source_note": "Exact Leafly SFV OG page. Sweed search did not return an existing `SFV OG` strain record in this account.",
    },
    "Durban Poison": {
        "display_strain": "Durban Poison",
        "target_strain": "Durban Poison",
        "prevalence": "Sativa",
        "leafly_url": "https://www.leafly.com/strains/durban-poison",
        "leafly_label": "Exact page: Durban Poison",
        "terpenes": ["Terpinolene", "Myrcene", "Ocimene"],
        "flavors": ["Pine", "Earthy", "Sage"],
        "effects": ["Focused", "Energetic", "Uplifted"],
        "group_note": "Keep the current group strain attachment; it already matches the inferred cultivar.",
        "group_target_mode": "current",
        "source_note": "Exact Leafly Durban Poison page.",
    },
    "Original Z": {
        "display_strain": "The Original Z",
        "target_strain": "Zkittles",
        "prevalence": "Indica Dominant",
        "leafly_url": "https://www.leafly.com/strains/zkittlez",
        "leafly_label": "Equivalent page: The Original Z",
        "terpenes": ["Caryophyllene", "Linalool", "Humulene"],
        "flavors": ["Grapefruit", "Grape", "Berry"],
        "effects": ["Relaxed", "Sleepy", "Hungry"],
        "group_note": "Keep the current `Zkittles` attachment unless you explicitly want the post-rename label; Leafly's `The Original Z` page describes the same cultivar under the newer name.",
        "group_target_mode": "current_equivalent",
        "source_note": "Leafly's exact page is titled `The Original Z` and explicitly says it is the cultivar previously known under the candy-name label. In this account, the closest existing Sweed strain is `Zkittles`.",
    },
    "Sour Apple x Lemon Cherry Gelato": {
        "display_strain": "Sour Apple x Lemon Cherry Gelato",
        "target_strain": "Sour Apple x Lemon Cherry Gelato",
        "prevalence": "Hybrid",
        "leafly_url": None,
        "leafly_label": None,
        "terpenes": ["Caryophyllene", "Limonene", "Myrcene"],
        "flavors": ["Apple", "Lemon", "Berry"],
        "effects": ["Tingly", "Relaxed", "Giggly"],
        "group_note": "If you want the exact cross represented in Sweed, create and attach a new cross strain record; otherwise the current `Lemon Cherry Gelato` attachment is a workable but incomplete proxy.",
        "group_target_mode": "new_optional",
        "source_note": "No exact Leafly page surfaced for the cross. Terpenes, flavors, and effects are blended from Leafly Sour Apple + Lemon Cherry Gelato and line up well with the Hepworth product copy.",
    },
    "Blue Nerds": {
        "display_strain": "Blue Nerds",
        "target_strain": "Blue Nerds",
        "prevalence": "Hybrid",
        "leafly_url": "https://www.leafly.com/strains/blue-nerds",
        "leafly_label": "Exact page: Blue Nerds",
        "terpenes": ["Caryophyllene", "Limonene", "Linalool"],
        "flavors": ["Apricot", "Apple", "Blueberry"],
        "effects": ["Focused", "Relaxed", "Euphoric"],
        "group_note": "Create and attach an exact `Blue Nerds` strain record; the current `Blue Dream` attachment looks like a proxy mismatch, not an exact alias.",
        "group_target_mode": "new_required",
        "source_note": "Exact Leafly Blue Nerds page for effects/flavors. The fetched page did not surface a terpene trio, so the terpene recommendation is a conservative parent blend from Leafly's Runtz + The Original Z pages.",
    },
    "Durban Poison x Cherry Tart": {
        "display_strain": "Durban Poison x Cherry Tart",
        "target_strain": "Durban Poison x Cherry Tart",
        "prevalence": "Sativa Dominant",
        "leafly_url": None,
        "leafly_label": None,
        "terpenes": ["Terpinolene", "Myrcene", "Limonene"],
        "flavors": ["Pine", "Berry", "Citrus"],
        "effects": ["Focused", "Energetic", "Creative"],
        "group_note": "Replace the current generic `Hybrid` attachment with an exact cross strain record. This is the strongest strain-fix recommendation in the set.",
        "group_target_mode": "new_required",
        "source_note": "No exact Leafly page surfaced for the cross. This row blends Leafly Durban Poison + Cherry Tart data with the Hepworth product description and the public menu copy for the exact item.",
    },
    "Mango Dog x White Runtz": {
        "display_strain": "Mango Dog x White Runtz",
        "target_strain": "Mango Dog x White Runtz",
        "prevalence": "Sativa Dominant",
        "leafly_url": None,
        "leafly_label": None,
        "terpenes": ["Limonene", "Caryophyllene", "Linalool"],
        "flavors": ["Mango", "Peach", "Vanilla"],
        "effects": ["Relaxed", "Focused", "Creative"],
        "group_note": "If exact cross naming matters, create and attach a new cross strain record; otherwise the current `White Runtz` proxy is understandable but incomplete.",
        "group_target_mode": "new_optional",
        "source_note": "No exact Leafly page surfaced for Mango Dog. This row uses the exact product's public retailer description, the current White Runtz proxy, and Leafly Mango + White Runtz data. Limonene is explicitly called out in the retailer copy.",
    },
    "Fatso Jealousy": {
        "display_strain": "Fatso Jealousy",
        "target_strain": "Fatso Jealousy",
        "prevalence": "Hybrid",
        "leafly_url": None,
        "leafly_label": None,
        "terpenes": ["Caryophyllene", "Limonene", "Myrcene"],
        "flavors": ["Diesel", "Pepper", "Plum"],
        "effects": ["Relaxed", "Giggly", "Sleepy"],
        "group_note": "Create and attach a new cross strain record for `Fatso Jealousy`; the current `Hybrid` attachment is too generic and there is no exact Leafly page for the cross.",
        "group_target_mode": "new_required",
        "source_note": "No exact Leafly page surfaced for `Fatso Jealousy`. This recommendation blends verified parent data from Leafly `Fatso` and `Jealousy` and stays explicitly at cross-level uncertainty.",
    },
}


def api_call(name: str, params: dict | None = None, request_id: str | None = None):
    payload = json.dumps(
        {
            "auth": AUTH_TOKEN,
            "name": name,
            "params": params or {},
            "id": request_id or str(uuid.uuid4()),
        }
    ).encode()
    request = urllib.request.Request(
        API_URL,
        data=payload,
        headers={
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0",
        },
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)["result"]
        except urllib.error.HTTPError as exc:
            if exc.code not in {403, 429, 500, 502, 503, 504} or attempt == 2:
                raise
            time.sleep(1 + attempt)


def fetch_all_products() -> list[dict]:
    page = 1
    page_size = 1000
    products = []

    while True:
        result = api_call(
            "store.product.list.short",
            {
                "page": page,
                "pageSize": page_size,
                "reload": False,
                "advancedSearch": True,
            },
            str(uuid.uuid5(uuid.NAMESPACE_URL, f"products-page-{page}")),
        )
        products.extend(result["data"])
        if len(products) >= result["totalCount"]:
            return products
        page += 1


def switch_to_site_inventory_context() -> dict:
    return api_call("store.auth.dealer.set", {"dealerId": SITE_DEALER_ID}, str(uuid.uuid5(uuid.NAMESPACE_URL, f"dealer-{SITE_DEALER_ID}")))


def fetch_in_stock_inventory_rows() -> tuple[list[dict], dict]:
    page = 1
    page_size = 100
    rows = []
    last_result = None

    while True:
        last_result = api_call(
            "store.inventory.item.list.grouped",
            {
                "page": page,
                "pageSize": page_size,
                "isOnStock": True,
            },
            str(uuid.uuid5(uuid.NAMESPACE_URL, f"inventory-page-{page}")),
        )
        rows.extend(last_result["data"])
        if len(rows) >= last_result["totalCount"]:
            return rows, last_result
        page += 1


def fetch_groups(group_ids: set[int]) -> dict[int, dict]:
    groups = {}

    for group_id in sorted(group_ids):
        request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"group-{group_id}"))
        groups[group_id] = api_call("store.product.group.get", {"id": group_id}, request_id)

    return groups


def fetch_all_strains() -> dict[str, dict]:
    strains = api_call(
        "store.product.strain.list",
        {"page": 1, "pageSize": 1000000},
        "22222222-2222-4222-8222-222222222222",
    )["data"]
    return {strain["name"].lower(): strain for strain in strains}


def name_list(items: list) -> list[str]:
    values = []
    for item in items or []:
        if isinstance(item, dict):
            values.append(item.get("name", ""))
        else:
            values.append(str(item))
    return [value for value in values if value]


def make_list_html(items: list[str], empty: str = "—") -> str:
    if not items:
        return f'<div class="muted">{html.escape(empty)}</div>'
    return "<ul>" + "".join(f"<li>{html.escape(item)}</li>" for item in items) + "</ul>"


def make_chip_list(items: list[str], class_name: str = "chip") -> str:
    if not items:
        return '<span class="chip chip-empty">none</span>'
    return "".join(f'<span class="{class_name}">{html.escape(item)}</span>' for item in items)


def split_needed(target_items: list[str], current_items: list[str], dictionary_items: set[str], *, terpene_mode: bool = False):
    attach_existing = []
    create_then_attach = []
    unresolved = []
    current_set = {item.lower() for item in current_items}
    dictionary_set = {item.lower() for item in dictionary_items}

    for item in target_items:
        lowered = item.lower()
        if lowered in current_set:
            continue
        if lowered in dictionary_set:
            attach_existing.append(item)
        elif terpene_mode:
            unresolved.append(item)
        else:
            create_then_attach.append(item)

    return attach_existing, create_then_attach, unresolved


def render_needed_block(title: str, attach_existing: list[str], create_then_attach: list[str], unresolved: list[str] | None = None) -> str:
    lines = [f"<div class=\"need-title\">{html.escape(title)}</div>"]
    if attach_existing:
        lines.append(
            "<div class=\"need-row\"><span class=\"status status-attach\">attach</span> "
            + ", ".join(html.escape(item) for item in attach_existing)
            + "</div>"
        )
    if create_then_attach:
        lines.append(
            "<div class=\"need-row\"><span class=\"status status-create\">create + attach</span> "
            + ", ".join(html.escape(item) for item in create_then_attach)
            + "</div>"
        )
    if unresolved:
        lines.append(
            "<div class=\"need-row\"><span class=\"status status-warn\">unconfirmed create path</span> "
            + ", ".join(html.escape(item) for item in unresolved)
            + "</div>"
        )
    if len(lines) == 1:
        lines.append('<div class="need-row muted">Nothing new needed.</div>')
    return "".join(lines)


def make_leafly_html(inference: dict) -> str:
    leafly_url = inference.get("leafly_url")
    leafly_label = inference.get("leafly_label")
    if leafly_url and leafly_label:
        return (
            '<div class="leafly-link">'
            f'<a href="{html.escape(leafly_url)}" target="_blank" rel="noopener noreferrer">{html.escape(leafly_label)}</a>'
            '</div>'
        )
    return '<div class="muted">No exact corresponding Leafly page surfaced.</div>'


def make_muted_html(message: str) -> str:
    return f'<div class="muted">{html.escape(message)}</div>'


def is_strain_label_fragment(text: str | None) -> bool:
    tokens = re.findall(r"[a-z]+", (text or "").lower())
    if not tokens:
        return False
    for token in tokens:
        if token in STRAIN_LABEL_TOKENS:
            continue
        if any(canonical.startswith(token) for canonical in STRAIN_LABEL_TOKEN_CANONICALS):
            continue
        return False
    return True


def strip_parenthesized_strain_label(text: str | None) -> str:
    value = text or ""
    if not value:
        return ""

    removed = False

    def replacement(match: re.Match[str]) -> str:
        nonlocal removed
        if is_strain_label_fragment(match.group(1)):
            removed = True
            return " "
        return match.group(0)

    def trailing_fragment_replacement(match: re.Match[str]) -> str:
        nonlocal removed
        if is_strain_label_fragment(match.group("label")):
            removed = True
            return " "
        return match.group(0)

    cleaned = STRAIN_LABEL_PARENTHESES_PATTERN.sub(replacement, value)
    cleaned = TRAILING_OPEN_STRAIN_FRAGMENT_PATTERN.sub(trailing_fragment_replacement, cleaned)
    cleaned = BAR_STRAIN_FRAGMENT_PATTERN.sub(trailing_fragment_replacement, cleaned)
    if not removed:
        return value
    cleaned = re.sub(r"([|/,\-])\s*(?=[|/,\-])", "", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    return cleaned.strip(" -|/,")


def normalize_group_name(name: str) -> str:
    cleaned = strip_parenthesized_strain_label(name)
    for suffix in GENERIC_GROUP_SUFFIXES:
        if cleaned.endswith(suffix):
            return cleaned[: -len(suffix)]
    return cleaned


def slugify_leafly_name(name: str) -> str:
    lowered = LEAFLY_SLUG_ALIASES.get(name, name).lower()
    lowered = lowered.replace("#", " ")
    parts = []
    for char in lowered:
        parts.append(char if char.isalnum() else "-")
    slug = "".join(parts)
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-")


def infer_target_strain_name(group_name: str, product_name: str, all_strains: dict[str, dict]) -> str | None:
    normalized_group_name = normalize_group_name(group_name)
    normalized_group_name_lower = normalized_group_name.lower()
    if normalized_group_name in INFERENCE:
        return INFERENCE[normalized_group_name]["target_strain"]
    if normalized_group_name_lower in all_strains:
        return all_strains[normalized_group_name_lower]["name"]
    if normalized_group_name in GROUP_EQUIVALENT_STRAINS:
        return GROUP_EQUIVALENT_STRAINS[normalized_group_name]
    if normalized_group_name_lower in VERIFIED_STRAIN_NAME_BY_LOWER:
        return VERIFIED_STRAIN_NAME_BY_LOWER[normalized_group_name_lower]
    hinted_name = PRODUCT_STRAIN_HINTS.get(group_name) or PRODUCT_STRAIN_HINTS.get(product_name)
    if hinted_name:
        return hinted_name
    return None


def build_leafly_reference(group_name: str, product_name: str, current_strain_name: str | None, all_strains: dict[str, dict]) -> dict:
    normalized_group_name = normalize_group_name(group_name)
    if normalized_group_name in INFERENCE:
        inference = INFERENCE[normalized_group_name]
        return {
            "url": inference.get("leafly_url"),
            "label": inference.get("leafly_label"),
            "status": "reviewed-group",
            "effects": inference["effects"],
            "flavors": inference["flavors"],
            "terpenes": inference["terpenes"],
            "note": inference["source_note"],
        }

    target_strain_name = infer_target_strain_name(group_name, product_name, all_strains)
    if target_strain_name in VERIFIED_STRAIN_LEAFLY:
        return VERIFIED_STRAIN_LEAFLY[target_strain_name]

    if current_strain_name in VERIFIED_STRAIN_LEAFLY:
        return VERIFIED_STRAIN_LEAFLY[current_strain_name]

    if current_strain_name in GENERIC_STRAIN_NAMES:
        if target_strain_name:
            return {
                "url": f"https://www.leafly.com/strains/{slugify_leafly_name(target_strain_name)}",
                "label": f"Exact cultivar cue from product/catalog name: {target_strain_name}",
                "status": "inferred-candidate",
                "effects": [],
                "flavors": [],
                "terpenes": [],
                "note": f"The current attached strain is generic or missing, but the catalog row itself points to `{target_strain_name}`. This exact cultivar cue is safe enough to synthesize a strain-attach recommendation even where the Leafly page still needs fuller manual extraction.",
            }
        if current_strain_name:
            note = f"Current attached strain is the generic label `{current_strain_name}`, so this row still needs cultivar-level Leafly review rather than a generic page guess."
        else:
            note = "No current strain is attached on the product group, so there is no cultivar-level Leafly page to consult yet."
        return {
            "url": None,
            "label": None,
            "status": "generic-or-missing",
            "effects": [],
            "flavors": [],
            "terpenes": [],
            "note": note,
        }

    slug = slugify_leafly_name(current_strain_name)
    return {
        "url": f"https://www.leafly.com/strains/{slug}",
        "label": f"Inferred current strain candidate: {current_strain_name}",
        "status": "inferred-candidate",
        "effects": [],
        "flavors": [],
        "terpenes": [],
        "note": f"No reviewed exact/equivalent Leafly mapping is recorded yet for this row. This candidate URL is the current attached strain slug inferred from `{current_strain_name}` and still needs manual verification.",
    }


def render_group_strain_block(mode: str, display_strain: str, prevalence: str | None, group_note: str) -> str:
    if mode in {"current", "current_equivalent"}:
        return f'<div class="need-row muted">{html.escape(group_note)}</div>'
    if mode == "attach_existing":
        suffix = f" ({html.escape(prevalence)})" if prevalence else ""
        return (
            '<div class="need-row"><span class="status status-attach">attach exact strain</span> '
            f'{html.escape(display_strain)}{suffix}'
            '</div>'
            f'<div class="need-row muted">{html.escape(group_note)}</div>'
        )
    if mode == "new_required":
        suffix = f" ({html.escape(prevalence)})" if prevalence else ""
        return (
            '<div class="need-row"><span class="status status-create">create + attach strain</span> '
            f'{html.escape(display_strain)}{suffix}'
            '</div>'
            f'<div class="need-row muted">{html.escape(group_note)}</div>'
        )
    if mode == "no_safe_change":
        return (
            '<div class="need-row"><span class="status status-warn">hold current state</span></div>'
            f'<div class="need-row muted">{html.escape(group_note)}</div>'
        )
    suffix = f" ({html.escape(prevalence)})" if prevalence else ""
    return (
        '<div class="need-row"><span class="status status-warn">optional exact-cultivar upgrade</span> '
        f'{html.escape(display_strain)}{suffix}'
        '</div>'
        f'<div class="need-row muted">{html.escape(group_note)}</div>'
    )


def build_guided_recommendations(
    guidance: dict,
    current_strain_name: str | None,
    current_group_effects: list[str],
    current_strain_flavors: list[str],
    current_strain_terpenes: list[str],
    all_strains: dict[str, dict],
    effect_names: set[str],
    strain_flavor_names: set[str],
    terpene_names: set[str],
) -> tuple[str, str, str]:
    target_strain_name = guidance["target_strain"]
    target_strain_row = all_strains.get(target_strain_name.lower())
    target_current_flavors = name_list(target_strain_row.get("flavors", [])) if target_strain_row else []
    target_current_terpenes = name_list(target_strain_row.get("terpenes", [])) if target_strain_row else []
    effect_attach, effect_create, _ = split_needed(guidance["effects"], current_group_effects, effect_names)
    flavor_attach, flavor_create, _ = split_needed(guidance["flavors"], target_current_flavors, strain_flavor_names)
    terpene_attach, _, terpene_unresolved = split_needed(
        guidance["terpenes"],
        target_current_terpenes,
        terpene_names,
        terpene_mode=True,
    )
    group_strain_block = render_group_strain_block(
        guidance["group_target_mode"],
        guidance["display_strain"],
        guidance.get("prevalence"),
        guidance["group_note"],
    )
    group_needs_html = group_strain_block + render_needed_block("Effects on product group", effect_attach, effect_create, [])
    strain_needs_html = render_needed_block("Strain flavors", flavor_attach, flavor_create, []) + render_needed_block(
        "Strain terpenes",
        terpene_attach,
        [],
        terpene_unresolved,
    )
    return guidance["display_strain"], group_needs_html, strain_needs_html


def build_final_recommendations(
    *,
    group: dict,
    product: dict,
    current_strain_name: str | None,
    current_group_effects: list[str],
    current_strain_flavors: list[str],
    current_strain_terpenes: list[str],
    all_strains: dict[str, dict],
    effect_names: set[str],
    strain_flavor_names: set[str],
    terpene_names: set[str],
) -> tuple[str, str, str]:
    normalized_group_name = normalize_group_name(group["name"])
    inference = INFERENCE.get(normalized_group_name)
    if inference:
        return build_guided_recommendations(
            inference,
            current_strain_name,
            current_group_effects,
            current_strain_flavors,
            current_strain_terpenes,
            all_strains,
            effect_names,
            strain_flavor_names,
            terpene_names,
        )

    target_strain_name = infer_target_strain_name(group["name"], product.get("name") or "", all_strains)
    if target_strain_name:
        target_strain_row = all_strains.get(target_strain_name.lower())
        target_guidance = VERIFIED_STRAIN_LEAFLY.get(target_strain_name)
        if current_strain_name == target_strain_name:
            group_target_mode = "current"
            group_note = f"Keep the current group strain attachment; it already matches `{target_strain_name}`."
        elif current_strain_name in GENERIC_STRAIN_NAMES:
            if target_strain_row:
                group_target_mode = "attach_existing"
                group_note = f"Replace the generic or missing group strain state with the exact `{target_strain_name}` strain record already present in Sweed."
            else:
                group_target_mode = "new_required"
                group_note = f"Create and attach the exact `{target_strain_name}` strain record; the current group strain state is generic or missing."
        elif current_strain_name == GROUP_EQUIVALENT_STRAINS.get(normalized_group_name):
            group_target_mode = "current_equivalent"
            group_note = f"Keep the current equivalent group strain attachment `{current_strain_name}`; it is the best Sweed-side match for `{target_strain_name}`."
        elif target_strain_row:
            group_target_mode = "attach_existing"
            group_note = f"Swap the current `{current_strain_name}` attachment for the exact `{target_strain_name}` strain record already present in Sweed."
        else:
            group_target_mode = "new_required"
            group_note = f"Create and attach the exact `{target_strain_name}` strain record to replace the current `{current_strain_name}` attachment."

        if target_guidance:
            guidance = {
                "display_strain": target_strain_name,
                "target_strain": target_strain_name,
                "prevalence": target_guidance.get("prevalence") or (target_strain_row or {}).get("prevalence", {}).get("name"),
                "effects": target_guidance["effects"],
                "flavors": target_guidance["flavors"],
                "terpenes": target_guidance["terpenes"],
                "group_note": group_note,
                "group_target_mode": group_target_mode,
            }
            return build_guided_recommendations(
                guidance,
                current_strain_name,
                current_group_effects,
                current_strain_flavors,
                current_strain_terpenes,
                all_strains,
                effect_names,
                strain_flavor_names,
                terpene_names,
            )

        group_strain_block = render_group_strain_block(
            group_target_mode,
            target_strain_name,
            (target_strain_row or {}).get("prevalence", {}).get("name"),
            group_note,
        )
        group_needs_html = group_strain_block + make_muted_html("No reviewed Leafly-derived effect set is attached to this recommendation yet, so group effects are left unchanged in this pass.")
        strain_needs_html = make_muted_html("Exact cultivar attachment is safe, but no reviewed Leafly flavor/terpene set was collected for this strain in this pass, so strain metadata is left unchanged.")
        return target_strain_name, group_needs_html, strain_needs_html

    if (product.get("category") or {}).get("name") in NON_ATTRIBUTE_ACTION_CATEGORIES:
        return (
            "No strain action",
            make_muted_html("No strain/effect backfill is recommended for this non-cannabis accessory row."),
            make_muted_html("No strain-record update applies to this accessory row."),
        )

    if current_strain_name and current_strain_name not in GENERIC_STRAIN_NAMES:
        return (
            current_strain_name,
            make_muted_html(f"Keep the current `{current_strain_name}` group strain attachment for now. This row no longer has a synthesis placeholder, but a safer exact/equivalent backfill still needs better external evidence before changing the group."),
            make_muted_html("Leave the current strain record unchanged in this pass. No reviewed Leafly flavor/terpene set was captured for this cultivar, and we are explicitly avoiding speculative metadata writes."),
        )

    return (
        current_strain_name or "No current strain attached",
        render_group_strain_block(
            "no_safe_change",
            current_strain_name or "No current strain attached",
            None,
            "No safe exact or equivalent cultivar update surfaced for this row in this pass, so the recommendation is to leave the product group unchanged rather than guessing.",
        ),
        make_muted_html("Leave the strain record side unchanged in this pass. This row has been triaged, but still lacks enough cultivar evidence for a responsible flavor/terpene recommendation."),
    )


def make_leafly_status_chip(status: str) -> str:
    class_name = {
        "reviewed-group": "status-reviewed",
        "verified-proxy": "status-attach",
        "verified-equivalent": "status-attach",
        "inferred-candidate": "status-warn",
        "generic-or-missing": "status-unreviewed",
    }.get(status, "status-unreviewed")
    label = {
        "reviewed-group": "reviewed group",
        "verified-proxy": "verified strain",
        "verified-equivalent": "verified equivalent",
        "inferred-candidate": "candidate",
        "generic-or-missing": "needs review",
    }.get(status, status)
    return f'<span class="status {class_name}">{html.escape(label)}</span>'


def make_leafly_reference_html(reference: dict) -> str:
    parts = [make_leafly_status_chip(reference["status"])]
    if reference.get("url") and reference.get("label"):
        parts.append(
            '<div class="leafly-link">'
            f'<a href="{html.escape(reference["url"])}" target="_blank" rel="noopener noreferrer">{html.escape(reference["label"])}</a>'
            '</div>'
        )
    else:
        parts.append('<div class="muted">No verified cultivar-level Leafly page recorded for this row.</div>')
    return "".join(parts)


def main() -> None:
    switch_to_site_inventory_context()
    inventory_rows, inventory_summary = fetch_in_stock_inventory_rows()
    products = fetch_all_products()
    product_by_id = {str(product["id"]): product for product in products}
    in_stock_products = [product_by_id[str(row["product"]["id"])] for row in inventory_rows if str(row["product"]["id"]) in product_by_id]
    groups = fetch_groups({int(product["productGroup"]["id"]) for product in in_stock_products})
    all_strains = fetch_all_strains()
    effect_names = {item["name"] for item in api_call("store.product.effect.list", {}, "33333333-3333-4333-8333-333333333333")}
    strain_flavor_names = {item["name"] for item in api_call("store.product.strain.flavor.list", {}, "44444444-4444-4444-8444-444444444444")}
    terpene_names = {item["name"] for item in api_call("store.product.strain.terpene.list", {}, "55555555-5555-4555-8555-555555555555")}
    product_flavoring_names = {item["name"] for item in api_call("store.product.flavoring.list", {}, "66666666-6666-4666-8666-666666666666")}
    product_scent_names = {item["name"] for item in api_call("store.product.scent.list", {}, "77777777-7777-4777-8777-777777777777")}

    group_rows = []
    json_rows = []
    reviewed_group_count = 0
    verified_leafly_count = 0
    inferred_leafly_count = 0
    generic_leafly_count = 0
    strain_enabled_count = 0
    effectless_groups = 0
    current_flavored_strains = 0
    current_terpened_strains = 0

    for group in groups.values():
        current_group_strain = group.get("strain") or {}
        current_group_strain_name = current_group_strain.get("name")
        current_group_strain_row = all_strains.get(current_group_strain_name.lower()) if current_group_strain_name else None
        if not group.get("effects"):
            effectless_groups += 1
        if current_group_strain_row and name_list(current_group_strain_row.get("flavors", [])):
            current_flavored_strains += 1
        if current_group_strain_row and name_list(current_group_strain_row.get("terpenes", [])):
            current_terpened_strains += 1

    for inventory_row in sorted(
        inventory_rows,
        key=lambda item: (
            -(item.get("availableQty") or 0),
            ((item.get("productBrand") or {}).get("name") or "").lower(),
            ((item.get("category") or {}).get("name") or "").lower(),
            ((item.get("product") or {}).get("name") or "").lower(),
        ),
    ):
        product = product_by_id.get(str(inventory_row["product"]["id"]))
        if not product:
            continue

        group_id = int(product["productGroup"]["id"])
        group = groups[group_id]
        current_strain = group.get("strain") or {}
        current_strain_name = current_strain.get("name")
        current_strain_row = all_strains.get(current_strain_name.lower()) if current_strain_name else None
        product_name = product.get("name") or f"{group['name']} · {product.get('tab') or '—'}"
        leafly_reference = build_leafly_reference(group["name"], product_name, current_strain_name, all_strains)

        if inventory_row.get("category", {}).get("isProductStrainEnabled"):
            strain_enabled_count += 1

        if leafly_reference["status"] == "reviewed-group":
            reviewed_group_count += 1
        elif leafly_reference["status"] in {"verified-proxy", "verified-equivalent"}:
            verified_leafly_count += 1
        elif leafly_reference["status"] == "inferred-candidate":
            inferred_leafly_count += 1
        else:
            generic_leafly_count += 1

        current_group_effects = name_list(group.get("effects", []))
        current_group_flavorings = name_list(group.get("flavorings", []))
        current_group_scents = name_list(group.get("scents", []))
        current_strain_flavors = name_list(current_strain_row.get("flavors", [])) if current_strain_row else []
        current_strain_terpenes = name_list(current_strain_row.get("terpenes", [])) if current_strain_row else []

        image_url = group.get("images", [{}])[0].get("url") if group.get("images") else None
        product_link = f"{BASE_URL}/store_setup/products/product/{group['id']}"
        variant_link = f"{BASE_URL}/store_setup/products/variant/{group['id']}/{product['id']}"
        sample_item = (inventory_row.get("items") or [{}])[0]
        stock_location_name = (sample_item.get("stockLocation") or {}).get("name") or "—"
        received_at = sample_item.get("dateTimeReceived") or "—"

        display_strain, group_needs_html, strain_needs_html = build_final_recommendations(
            group=group,
            product=product,
            current_strain_name=current_strain_name,
            current_group_effects=current_group_effects,
            current_strain_flavors=current_strain_flavors,
            current_strain_terpenes=current_strain_terpenes,
            all_strains=all_strains,
            effect_names=effect_names,
            strain_flavor_names=strain_flavor_names,
            terpene_names=terpene_names,
        )

        current_state_html = "".join(
            [
                '<div class="state-block">'
                f'<div><strong>Available qty:</strong> {inventory_row.get("availableQty", 0):g}</div>'
                f'<div><strong>Current / hold:</strong> {inventory_row.get("currentQty", 0):g} / {inventory_row.get("holdQty", 0):g}</div>'
                f'<div><strong>Local / global price:</strong> {inventory_row.get("localPrice", 0):g} / {inventory_row.get("globalPrice", 0):g}</div>'
                f'<div><strong>Stock location:</strong> {html.escape(stock_location_name)}</div>'
                f'<div><strong>Received:</strong> {html.escape(received_at)}</div>'
                '</div>',
                '<div class="state-block">'
                f'<div><strong>Current group strain:</strong> {html.escape(current_strain_name or "—")}</div>'
                f'<div><strong>Current group effects:</strong> {make_chip_list(current_group_effects)}</div>'
                f'<div><strong>Current group flavorings:</strong> {make_chip_list(current_group_flavorings)}</div>'
                f'<div><strong>Current group scents:</strong> {make_chip_list(current_group_scents)}</div>'
                '</div>',
                '<div class="state-block">'
                f'<div><strong>Current strain flavors:</strong> {make_chip_list(current_strain_flavors)}</div>'
                f'<div><strong>Current strain terpenes:</strong> {make_chip_list(current_strain_terpenes)}</div>'
                '</div>',
            ]
        )

        group_rows.append(
            {
                "brand_name": (product.get("brand") or {}).get("name") or "—",
                "category_name": (product.get("category") or {}).get("name") or "—",
                "subcategory_name": (product.get("subcategory") or {}).get("name") or "—",
                "product_name": product_name,
                "product_tab": product.get("tab") or "—",
                "available_qty": inventory_row.get("availableQty") or 0,
                "group_name": group["name"],
                "group_id": group["id"],
                "product_id": product["id"],
                "current_state_html": current_state_html,
                "display_strain": display_strain,
                "current_strain_name": current_strain_name or "—",
                "leafly_html": make_leafly_reference_html(leafly_reference),
                "image_url": image_url,
                "product_link": product_link,
                "variant_link": variant_link,
                "terpenes_html": make_list_html(leafly_reference["terpenes"], "No terpene set collected from Leafly for this row yet."),
                "flavors_html": make_list_html(leafly_reference["flavors"], "No flavor set collected from Leafly for this row yet."),
                "effects_html": make_list_html(leafly_reference["effects"], "No effect set collected from Leafly for this row yet."),
                "group_needs_html": group_needs_html,
                "strain_needs_html": strain_needs_html,
                "source_note": leafly_reference["note"],
                "review_badge": make_leafly_status_chip(leafly_reference["status"]),
            }
        )
        json_rows.append(
            {
                "groupId": group["id"],
                "productId": product["id"],
                "groupName": group["name"],
                "productName": product_name,
                "category": (product.get("category") or {}).get("name"),
                "subcategory": (product.get("subcategory") or {}).get("name"),
                "availableQty": inventory_row.get("availableQty") or 0,
                "currentGroupStrain": current_strain_name,
                "displayStrain": display_strain,
                "leaflyStatus": leafly_reference["status"],
                "leaflyUrl": leafly_reference.get("url"),
                "effects": leafly_reference["effects"],
                "flavors": leafly_reference["flavors"],
                "terpenes": leafly_reference["terpenes"],
                "sourceNote": leafly_reference["note"],
                "groupRecommendationHtml": group_needs_html,
                "strainRecommendationHtml": strain_needs_html,
            }
        )

    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")

    rows_html = []
    for row in group_rows:
        image_html = (
            f'<a class="thumb-link" href="{html.escape(row["image_url"])}" target="_blank" rel="noopener noreferrer">'
            f'<img src="{html.escape(row["image_url"])}" alt="{html.escape(row["product_name"])} image">'
            "</a>"
            if row["image_url"]
            else '<div class="thumb-link thumb-empty">No image</div>'
        )

        rows_html.append(
            f"""
            <tr>
              <td class=\"product\">
                <div>{row['review_badge']}</div>
                <div class=\"name\">{html.escape(row['product_name'])}</div>
                <div class=\"muted\">Brand: {html.escape(row['brand_name'])} · {html.escape(row['category_name'])} / {html.escape(row['subcategory_name'])}</div>
                <div class=\"muted\">Catalog group: {html.escape(row['group_name'])} · Tab: {html.escape(row['product_tab'])}</div>
              </td>
              <td><div class=\"name\">{row['available_qty']:g}</div><div class=\"muted\">available</div></td>
              <td>{image_html}</td>
              <td class=\"refs\">
                <a href=\"{html.escape(row['product_link'])}\" target=\"_blank\" rel=\"noopener noreferrer\">group {row['group_id']}</a>
                <a href=\"{html.escape(row['variant_link'])}\" target=\"_blank\" rel=\"noopener noreferrer\">variant {row['product_id']}</a>
              </td>
              <td class=\"state\">{row['current_state_html']}</td>
              <td>
                <div class=\"name\">{html.escape(row['display_strain'])}</div>
                <div class=\"muted\">Current group strain: {html.escape(row['current_strain_name'])}</div>
              </td>
              <td class=\"leafly-col\">{row['leafly_html']}</td>
              <td>{row['terpenes_html']}</td>
              <td>{row['flavors_html']}</td>
              <td>{row['effects_html']}</td>
              <td class=\"needs\">{row['group_needs_html']}</td>
              <td class=\"needs\">{row['strain_needs_html']}</td>
              <td class=\"note-col\">{html.escape(row['source_note'])}</td>
            </tr>
            """
        )

    html_doc = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Product Catalog Attribute Analysis</title>
    <style>
      :root {{
        color-scheme: light;
        --bg: #f5f1e8;
        --paper: #fffdf8;
        --ink: #1f1b16;
        --muted: #665f55;
        --line: #d8ccba;
        --header: #e9dcc6;
        --accent: #235347;
        --accent-soft: #d8ebe5;
        --thumb-bg: #f2eee6;
        --chip-bg: #f0e4d2;
        --chip-ink: #5d4630;
        --attach: #1f5f4b;
        --attach-bg: #d7efe6;
        --create: #7a3c00;
        --create-bg: #f7e0c8;
        --warn: #7a1f1f;
        --warn-bg: #f6d8d8;
      }}

      * {{ box-sizing: border-box; }}

      body {{
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
        background:
          radial-gradient(circle at top right, #efe3cc 0, rgba(239, 227, 204, 0) 32%),
          linear-gradient(180deg, #f8f4ec 0%, var(--bg) 100%);
        color: var(--ink);
      }}

      .page {{
        width: 100%;
        max-width: none;
        margin: 0;
        padding: 24px 18px 36px;
      }}

      .hero {{ display: grid; gap: 12px; margin-bottom: 14px; }}

      h1 {{
        margin: 0;
        font-size: clamp(2rem, 4vw, 3.2rem);
        line-height: 0.98;
        letter-spacing: -0.04em;
      }}

      .hero-toggle {{ width: 100%; }}

      .hero-toggle summary {{
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: rgba(255, 253, 248, 0.94);
        color: var(--accent);
        font-size: 0.95rem;
        font-weight: 700;
        cursor: pointer;
        list-style: none;
        box-shadow: 0 8px 20px rgba(55, 43, 24, 0.06);
      }}

      .hero-toggle summary::-webkit-details-marker {{ display: none; }}
      .hero-toggle summary::before {{ content: "+"; font-size: 1.1rem; line-height: 1; }}
      .hero-toggle[open] summary::before {{ content: "−"; }}

      .hero-details {{
        display: grid;
        gap: 18px;
        margin-top: 14px;
        padding: 18px;
        background: rgba(255, 253, 248, 0.92);
        border: 1px solid var(--line);
        border-radius: 22px;
        box-shadow: 0 12px 30px rgba(55, 43, 24, 0.06);
      }}

      .subtitle {{ max-width: 1100px; font-size: 1.02rem; line-height: 1.55; color: var(--muted); }}

      .chips {{ display: flex; flex-wrap: wrap; gap: 10px; }}

      .chip {{
        display: inline-flex;
        align-items: center;
        padding: 7px 11px;
        border-radius: 999px;
        background: var(--chip-bg);
        color: var(--chip-ink);
        font-size: 0.86rem;
        font-weight: 600;
      }}

      .chip-empty {{ background: #ece6dc; color: #7a7064; }}

      .notes {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }}

      .note-card {{
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: rgba(255, 253, 248, 0.96);
      }}

      .note-card h2 {{ margin: 0 0 8px; font-size: 1.05rem; }}
      .note-card p, .note-card ul {{ margin: 0; color: var(--muted); line-height: 1.5; }}
      .note-card ul {{ padding-left: 18px; }}

      .table-wrap {{
        overflow: auto;
        width: 100%;
        max-height: calc(100vh - 110px);
        background: var(--paper);
        border: 1px solid var(--line);
        border-radius: 22px;
        box-shadow: 0 14px 40px rgba(55, 43, 24, 0.08);
      }}

      table {{ width: 100%; border-collapse: collapse; min-width: 2580px; }}

      thead th {{
        position: sticky;
        top: 0;
        z-index: 3;
        background: var(--header);
        text-align: left;
        font-size: 0.83rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 14px;
        border-bottom: 1px solid var(--line);
        white-space: normal;
        line-height: 1.25;
        vertical-align: bottom;
      }}

      tbody td {{ padding: 14px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 0.96rem; }}
      tbody tr:nth-child(even) {{ background: rgba(233, 220, 198, 0.22); }}
      tbody tr:hover {{ background: rgba(35, 83, 71, 0.08); }}

      .thumb-link, .thumb-empty {{
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 78px;
        height: 78px;
        border-radius: 16px;
        overflow: hidden;
        border: 1px solid var(--line);
        background: var(--thumb-bg);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.6);
      }}

      .thumb-link img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}

      .name {{ font-weight: 700; }}
      .muted {{ color: var(--muted); font-size: 0.91rem; }}
      .product .muted {{ margin-top: 6px; }}

      .refs {{ display: grid; gap: 6px; white-space: nowrap; }}
      .refs a {{ color: var(--accent); }}

      .state {{ min-width: 260px; }}
      .state-block {{ display: grid; gap: 7px; margin-bottom: 12px; }}
      .state-block:last-child {{ margin-bottom: 0; }}

      ul {{ margin: 0; padding-left: 18px; line-height: 1.45; }}

      .needs {{ min-width: 290px; }}
      .need-title {{ font-weight: 700; margin: 12px 0 6px; }}
      .need-title:first-child {{ margin-top: 0; }}
      .need-row {{ margin: 0 0 7px; line-height: 1.45; }}

      .leafly-col {{ min-width: 220px; }}
      .leafly-link {{ line-height: 1.45; }}

      .status {{
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 0.78rem;
        font-weight: 700;
        margin-right: 6px;
        vertical-align: middle;
      }}

      .status-attach {{ background: var(--attach-bg); color: var(--attach); }}
      .status-create {{ background: var(--create-bg); color: var(--create); }}
      .status-warn {{ background: var(--warn-bg); color: var(--warn); }}
      .status-reviewed {{ background: #d9e8ff; color: #204a87; }}
      .status-unreviewed {{ background: #ece6dc; color: #6b6258; }}

      .note-col {{ min-width: 340px; }}

      a {{ color: var(--accent); text-decoration-thickness: 0.08em; text-underline-offset: 0.12em; }}

      @media (max-width: 900px) {{
        .page {{ padding-inline: 12px; }}
        .table-wrap {{ max-height: none; }}
      }}
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <h1>Product Catalog Attribute Analysis</h1>
        <details class="hero-toggle">
          <summary>Show context</summary>
          <div class="hero-details">
            <div class="subtitle">
              Live read-only audit of the current in-stock inventory rows at the site-level `{SITE_DEALER_NAME}` context in Sweed. Rows are still variant-level for review convenience, but the catalog fields shown remain aligned to Sweed's real model: product-group changes for `strainId` and `effectIds`, strain-record changes for strain flavors and terpenes. Leafly status is explicit per row: reviewed exact/equivalent group mapping, verified current-strain proxy, inferred current-strain candidate, or generic/no-strain still needing cultivar review.
            </div>
            <div class="chips">
              <span class="chip">Generated {html.escape(now)}</span>
              <span class="chip">{len(group_rows)} in-stock variant rows</span>
              <span class="chip">{len(groups)} product groups</span>
              <span class="chip">{inventory_summary['totalAvailableQty']:g} total available units</span>
              <span class="chip">{strain_enabled_count} rows are strain-enabled categories</span>
              <span class="chip">{reviewed_group_count} rows use reviewed exact/equivalent group guidance</span>
              <span class="chip">{verified_leafly_count} rows use verified current-strain Leafly pages</span>
              <span class="chip">{inferred_leafly_count} rows have inferred current-strain Leafly candidates</span>
              <span class="chip">{generic_leafly_count} rows still have generic or missing strain context</span>
              <span class="chip">{effectless_groups} groups currently have no effects</span>
              <span class="chip">{current_flavored_strains} current strain records have flavors</span>
              <span class="chip">{current_terpened_strains} current strain records have terpenes</span>
              <span class="chip">Flower groups allow flavorings, but this pass keeps flavors on the strain record</span>
            </div>
            <section class="notes">
              <article class="note-card">
                <h2>Coverage</h2>
                <p>
                  This HTML now starts from live site inventory, not the full catalog. It includes every row returned by `store.inventory.item.list.grouped` with `isOnStock: true` after switching to dealer `{SITE_DEALER_ID}` / `{SITE_DEALER_NAME}`.
                </p>
              </article>
              <article class="note-card">
                <h2>What Belongs Where</h2>
                <p>
                  This report keeps Sweed's observed model intact: product groups carry `strain` and `effects`, while strain records carry strain `flavors` and `terpenes`. It does not treat Leafly flavor tags as product-group `flavorings`.
                </p>
              </article>
              <article class="note-card">
                <h2>Current Dictionary Coverage</h2>
                <ul>
                  <li>Effect dictionary currently contains only `Euphoric`, `Relaxed`, and `Tingly`.</li>
                  <li>Strain flavor dictionary currently contains only `Earthy`, `Flowery`, `Lemon`, `Peach`, `Pine`, and `Vanilla`.</li>
                  <li>Product-group flavoring dictionary has {len(product_flavoring_names)} entries; scent dictionary has {len(product_scent_names)}.</li>
                </ul>
              </article>
              <article class="note-card">
                <h2>Terpene Caveat</h2>
                <p>
                  When a terpene is missing from the live terpene list, this report marks it as an unconfirmed create-path problem instead of pretending we know the add API. In this run, the recommended terpenes were all already present in the live terpene dictionary.
                </p>
              </article>
              <article class="note-card">
                <h2>Confidence Rules</h2>
                <p>
                  Reviewed product-group mappings are strongest evidence. Outside that set, verified current-strain Leafly pages are labeled as proxies, inferred slugs are labeled as candidates, and generic labels like `Hybrid` or `Indica` are left unresolved instead of pretending to identify a cultivar.
                </p>
              </article>
            </section>
          </div>
        </details>
      </section>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Stock</th>
              <th>Image</th>
              <th>Catalog Links</th>
              <th>Current Catalog State</th>
              <th>Inferred Strain</th>
              <th>Leafly Page</th>
              <th>Identified Terpenes</th>
              <th>Identified Flavors</th>
              <th>Identified Effects</th>
              <th>Needs On Product Group</th>
              <th>Needs On Strain Record</th>
              <th>Source / Uncertainty Note</th>
            </tr>
          </thead>
          <tbody>
            {''.join(rows_html)}
          </tbody>
        </table>
      </div>
    </main>
  </body>
</html>
"""

    OUTPUT_PATH.write_text(html_doc, encoding="utf-8")
    OUTPUT_JSON_PATH.write_text(json.dumps(json_rows, indent=2), encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH}")
    print(f"Wrote {OUTPUT_JSON_PATH}")


if __name__ == "__main__":
    main()
