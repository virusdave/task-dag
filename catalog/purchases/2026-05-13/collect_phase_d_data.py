#!/usr/bin/env python3
"""Collect Phase (D) market research data for all approved pending purchases."""

import json
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

PACKET_DIR = Path(__file__).parent
PACKET_JSON = PACKET_DIR / "pending_purchases_2026_05_13.json"
OUTPUT_JSON = PACKET_DIR / "phase_d_market_research.json"
LOG_FILE = PACKET_DIR / "phase_d_collection_log.txt"

BEARER_TOKEN_PATH = Path.home() / ".secret" / "litalerts" / "bearer-token"
LITALERTS_BASE_URL = "https://public-api.litalerts.com"

def log(msg):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

def get_bearer_token():
    if not BEARER_TOKEN_PATH.exists():
        raise RuntimeError(f"LitAlerts token not found at {BEARER_TOKEN_PATH}")
    return BEARER_TOKEN_PATH.read_text().strip()

def query_litalerts(search_term, bearer_token, state="NY"):
    """Query LitAlerts for a product search term."""
    url = f"{LITALERTS_BASE_URL}/Products?search={urllib.parse.quote(search_term)}&state={state}&page=0&pagesize=50"
    
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {bearer_token}",
            "Accept": "application/json",
        }
    )
    
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode('utf-8'))
            return data.get('data', [])
    except urllib.error.HTTPError as e:
        if e.code == 401:
            log(f"  ERROR: LitAlerts auth failed (401) - token may be expired")
            return None
        log(f"  ERROR: LitAlerts HTTP {e.code}: {e.reason}")
        return []
    except Exception as e:
        log(f"  ERROR: LitAlerts request failed: {e}")
        return []

def collect_product_data(product, bearer_token):
    """Collect market research data for one product."""
    dp_id = product['distributorProductId']
    dp_name = product['distributorProductName']
    brand = product.get('targetBrand', '')
    variant = product.get('targetVariantName', '')
    
    log(f"Collecting: DP {dp_id} - {dp_name}")
    
    # Try multiple search terms
    search_terms = [
        variant,  # Full variant name
        f"{brand} {variant.split()[-1]}" if variant else brand,  # Brand + last word
        brand,  # Just brand
    ]
    
    all_matches = []
    for term in search_terms[:1]:  # Start with just variant name
        if not term:
            continue
        log(f"  Searching: {term}")
        matches = query_litalerts(term, bearer_token)
        if matches is None:  # Auth failure
            return None
        if matches:
            all_matches.extend(matches)
            break  # Stop on first successful search
        time.sleep(0.5)  # Rate limit
    
    # Extract pricing data
    prices = []
    processed_matches = []
    for match in all_matches[:20]:  # Limit to top 20
        price = match.get('price')
        if price and price > 0:
            prices.append(price)
            processed_matches.append({
                'retailer': match.get('locationName', 'Unknown'),
                'listingName': match.get('name', ''),
                'price': price,
                'effectiveDate': match.get('effectiveDate', ''),
                'productId': match.get('productId'),
            })
    
    result = {
        'distributorProductId': dp_id,
        'distributorProductName': dp_name,
        'site': product.get('_siteLabel'),
        'parsedBrand': brand,
        'parsedVariant': variant,
        'litAlerts': {
            'collectedAt': datetime.now(timezone.utc).isoformat(),
            'matchCount': len(processed_matches),
            'averagePrice': round(sum(prices) / len(prices), 2) if prices else None,
            'minPrice': round(min(prices), 2) if prices else None,
            'maxPrice': round(max(prices), 2) if prices else None,
            'medianPrice': round(sorted(prices)[len(prices)//2], 2) if prices else None,
            'matches': processed_matches,
        }
    }
    
    log(f"  ✓ Found {len(processed_matches)} matches, avg=${result['litAlerts']['averagePrice']}")
    return result

def main():
    log("=== Phase D Market Research Collection Started ===")
    
    # Load packet
    packet_data = json.loads(PACKET_JSON.read_text())
    products = packet_data['rows']
    log(f"Loaded {len(products)} products from packet")
    
    # Get token
    try:
        bearer_token = get_bearer_token()
        log("LitAlerts token loaded")
    except Exception as e:
        log(f"FATAL: {e}")
        return 1
    
    # Collect data
    results = {}
    failures = []
    
    for i, product in enumerate(products, 1):
        dp_id = product['distributorProductId']
        log(f"--- Product {i}/{len(products)} ---")
        
        result = collect_product_data(product, bearer_token)
        if result is None:
            log("FATAL: Auth failure - stopping collection")
            break
        
        if result:
            results[dp_id] = result
        else:
            failures.append(dp_id)
        
        # Save progress every 10 products
        if i % 10 == 0:
            output = {
                'collectedAt': datetime.now(timezone.utc).isoformat(),
                'packetSource': 'pending_purchases_2026_05_13.json',
                'productsCollected': len(results),
                'productsTotal': len(products),
                'products': results,
            }
            OUTPUT_JSON.write_text(json.dumps(output, indent=2))
            log(f"Checkpoint: Saved {len(results)} products")
    
    # Final save
    output = {
        'collectedAt': datetime.now(timezone.utc).isoformat(),
        'packetSource': 'pending_purchases_2026_05_13.json',
        'productsCollected': len(results),
        'productsTotal': len(products),
        'products': results,
    }
    OUTPUT_JSON.write_text(json.dumps(output, indent=2))
    
    log(f"=== Collection Complete ===")
    log(f"Success: {len(results)}/{len(products)}")
    log(f"Failures: {len(failures)}")
    log(f"Output: {OUTPUT_JSON}")
    
    return 0 if len(results) > 0 else 1

if __name__ == "__main__":
    sys.exit(main())
