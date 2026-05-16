#!/usr/bin/env python3
"""Generate Phase D market research review packet."""

import json
import html
from pathlib import Path
from datetime import datetime

PACKET_DIR = Path(__file__).parent
DATA_JSON = PACKET_DIR / "phase_d_market_research.json"
OUTPUT_HTML = PACKET_DIR / "phase_d_review.html"

data = json.loads(DATA_JSON.read_text())
products = list(data['products'].values())

# Statistics
total = len(products)
with_matches = sum(1 for p in products if p['litAlerts']['matchCount'] > 0)
without_matches = total - with_matches

# Group by site
by_site = {}
for p in products:
    site = p['site']
    if site not in by_site:
        by_site[site] = []
    by_site[site].append(p)

# Build HTML
html_parts = [f"""<!doctype html>
<html>
<head>
  <meta charset='utf-8'>
  <title>Phase D: Market Research Review - 2026-05-13</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }}
    .wrap {{ max-width: 95%; margin: 0 auto; }}
    h1 {{ margin-bottom: 24px; }}
    .stats {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }}
    .stat-card {{ background: white; padding: 16px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
    .stat-card .label {{ color: #666; font-size: 13px; }}
    .stat-card .value {{ font-size: 28px; font-weight: 700; margin-top: 4px; }}
    .site-section {{ margin-bottom: 32px; }}
    .site-header {{ background: #2d2a26; color: #f5efe1; padding: 12px 20px; border-radius: 8px; margin-bottom: 16px; }}
    .product {{ background: white; padding: 20px; border-radius: 8px; margin-bottom: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
    .product-header {{ display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }}
    .product-name {{ font-weight: 600; font-size: 15px; }}
    .dp-id {{ color: #666; font-size: 13px; }}
    .parsed {{ color: #0066cc; margin-bottom: 12px; }}
    .matches-summary {{ background: #f8f9fa; padding: 12px; border-radius: 4px; margin-bottom: 12px; }}
    .match-stats {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }}
    .match-stats .item {{ }}
    .match-stats .item .label {{ color: #666; font-size: 12px; }}
    .match-stats .item .value {{ font-weight: 600; font-size: 16px; }}
    .matches-list {{ margin-top: 12px; }}
    .match {{ padding: 8px; border-bottom: 1px solid #eee; font-size: 13px; }}
    .match:last-child {{ border-bottom: none; }}
    .match .retailer {{ font-weight: 600; color: #333; }}
    .match .price {{ color: #0066cc; font-weight: 600; }}
    .no-matches {{ color: #999; font-style: italic; }}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Phase D: Market Research Review</h1>
    <p style="color: #666; margin-bottom: 24px;">
      Generated: {html.escape(data['collectedAt'][:19])} | 
      Source: {html.escape(data['packetSource'])}
    </p>
    
    <div class="stats">
      <div class="stat-card">
        <div class="label">Total Products</div>
        <div class="value">{total}</div>
      </div>
      <div class="stat-card">
        <div class="label">With Competitor Matches</div>
        <div class="value" style="color: #0066cc;">{with_matches}</div>
      </div>
      <div class="stat-card">
        <div class="label">No Matches Found</div>
        <div class="value" style="color: #999;">{without_matches}</div>
      </div>
    </div>
"""]

for site, site_products in sorted(by_site.items()):
    html_parts.append(f"""
    <div class="site-section">
      <div class="site-header">
        <h2 style="margin: 0;">{html.escape(site)} ({len(site_products)} products)</h2>
      </div>
""")
    
    for p in sorted(site_products, key=lambda x: x['distributorProductName']):
        dp_id = p['distributorProductId']
        dp_name = p['distributorProductName']
        brand = p['parsedBrand']
        variant = p['parsedVariant']
        lit = p['litAlerts']
        
        match_count = lit['matchCount']
        avg_price = lit['averagePrice']
        min_price = lit['minPrice']
        max_price = lit['maxPrice']
        
        html_parts.append(f"""
      <div class="product">
        <div class="product-header">
          <div class="product-name">{html.escape(dp_name)}</div>
          <div class="dp-id">DP #{dp_id}</div>
        </div>
        <div class="parsed">→ {html.escape(brand)} - {html.escape(variant)}</div>
""")
        
        if match_count > 0:
            html_parts.append(f"""
        <div class="matches-summary">
          <div class="match-stats">
            <div class="item">
              <div class="label">Matches</div>
              <div class="value">{match_count}</div>
            </div>
            <div class="item">
              <div class="label">Avg Price</div>
              <div class="value">${avg_price:.2f}</div>
            </div>
            <div class="item">
              <div class="label">Min Price</div>
              <div class="value">${min_price:.2f}</div>
            </div>
            <div class="item">
              <div class="label">Max Price</div>
              <div class="value">${max_price:.2f}</div>
            </div>
          </div>
        </div>
        <details>
          <summary style="cursor: pointer; color: #0066cc; font-size: 13px;">Show {match_count} competitor listings</summary>
          <div class="matches-list">
""")
            for match in lit['matches']:
                retailer = match['retailer']
                listing = match['listingName']
                price = match['price']
                html_parts.append(f"""
            <div class="match">
              <span class="retailer">{html.escape(retailer)}</span> - 
              <span class="price">${price:.2f}</span>
              <div style="color: #666; margin-top: 2px;">{html.escape(listing)}</div>
            </div>
""")
            html_parts.append("""
          </div>
        </details>
""")
        else:
            html_parts.append("""
        <div class="no-matches">No competitor matches found in LitAlerts</div>
""")
        
        html_parts.append("      </div>")
    
    html_parts.append("    </div>")

html_parts.append("""
  </div>
</body>
</html>
""")

OUTPUT_HTML.write_text(''.join(html_parts))
print(f"Generated {OUTPUT_HTML}")
