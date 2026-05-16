#!/usr/bin/env python3
"""Parallel-optimized pending purchases generator."""

import concurrent.futures
import json
import sys
from pathlib import Path
from datetime import datetime, timezone

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_ROOT = WORKDIR.parents[2]
LEGACY_DIR = AUTOMATION_ROOT / "categories" / "2026-04-13"

if str(LEGACY_DIR) not in sys.path:
    sys.path.insert(0, str(LEGACY_DIR))
if str(WORKDIR) not in sys.path:
    sys.path.insert(0, str(WORKDIR))

import generate_pending_order_catalog_proposal as g
import _legacy_patches as patches

patches.install_patches(g)

SITES = [
    {"siteKey": "midtown", "siteLabel": "Midtown", "siteDealerId": 210705},
    {"siteKey": "bronx", "siteLabel": "Bronx", "siteDealerId": 210249},
]

def build_one_row(site, group):
    """Build a single row - safe for parallel execution."""
    try:
        row = g.build_row(group)
        row = patches.apply_brand_gm_override(row, g)
        row["_siteKey"] = site["siteKey"]
        row["_siteLabel"] = site["siteLabel"]
        
        brand = patches.normalize_brand(row.get("targetBrand"))
        is_mso = brand in patches.BRAND_GM_TARGET_OVERRIDES
        row["brandMsoClassification"] = "MSO" if is_mso else "non-MSO"
        
        print(f"  ✓ {site['siteLabel']:8} {row['targetBrand']:24} {row['targetVariantName'][:50]:50}", flush=True)
        return row, None
    except Exception as exc:
        print(f"  ✗ {site['siteLabel']:8} DP {group['distributorProductId']} FAILED: {exc}", flush=True)
        return None, {"site": site["siteLabel"], "dp": group['distributorProductId'], "name": group['distributorProductName'], "error": str(exc)}

def main():
    all_rows = []
    all_failures = []
    
    for site in SITES:
        print(f"[{site['siteLabel']}] Collecting pending purchases...")
        g.configure_runtime(site["siteKey"], output_stem=f"{site['siteKey']}_tmp")
        orders, groups = g.collect_pending_groups()
        print(f"[{site['siteLabel']}] {len(orders)} orders, {len(groups)} groups. Building rows with 20 parallel workers...")
        
        g.switch_context(g.STATE_DEALER_ID, g.STATE_DEALER_NAME)
        
        # Parallel build with 20 workers
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
            futures = [executor.submit(build_one_row, site, group) for group in groups]
            for future in concurrent.futures.as_completed(futures):
                row, failure = future.result()
                if row:
                    all_rows.append(row)
                if failure:
                    all_failures.append(failure)
    
    print(f"\n[COMPLETE] {len(all_rows)} rows built, {len(all_failures)} failures")
    
    # Write JSON
    output_json = WORKDIR / "pending_purchases_2026_05_15.json"
    output_json.write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sites": SITES,
        "rows": all_rows,
    }, indent=2, default=str))
    print(f"Wrote {output_json}")
    
    return 0 if all_rows else 1

if __name__ == "__main__":
    sys.exit(main())
