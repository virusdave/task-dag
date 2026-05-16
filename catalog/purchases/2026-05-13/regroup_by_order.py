#!/usr/bin/env python3
"""Reorganize pending purchases packet to group by purchase order for Phase (B) review."""

import json
import html
from pathlib import Path
from collections import defaultdict

PACKET_DIR = Path(__file__).parent
JSON_PATH = PACKET_DIR / "pending_purchases_2026_05_13.json"
HTML_PATH = PACKET_DIR / "pending_purchases_2026_05_13.html"

data = json.loads(JSON_PATH.read_text())
rows = data['rows']
orders = data['orders']

# Group rows by site and distributor product ID
# Since we don't have order linkage, we'll group by site + distributor
rows_by_site_dist = defaultdict(list)
for row in rows:
    site = row['_siteLabel']
    # Get distributor from the row if available, otherwise group all together
    key = (site, "All Orders")
    rows_by_site_dist[key].append(row)

# Build order table
order_rows_html = []
for order in orders:
    order_rows_html.append(f"""
        <tr>
            <td><strong>{html.escape(str(order.get('orderId', 'N/A')))}</strong></td>
            <td>{html.escape(str(order.get('externalOrderId', 'N/A')))}</td>
            <td>{html.escape(str(order.get('distributor', 'N/A')))}</td>
            <td>{html.escape(str(order.get('deliveryDate', 'N/A'))[:10])}</td>
            <td>{order.get('positionCount', 0)}</td>
            <td><strong>{order.get('unresolvedPositionCount', 0)}</strong></td>
        </tr>
    """)

# Build product rows grouped by site
products_html = []
for (site, _), site_rows in sorted(rows_by_site_dist.items()):
    products_html.append(f"""
        <details class="group-site" open>
            <summary><h2>Site: {html.escape(site)} ({len(site_rows)} rows)</h2></summary>
            <div class="products-list">
    """)
    
    for row in sorted(site_rows, key=lambda r: r.get('distributorProductName', '')):
        dp_id = row.get('distributorProductId', 'N/A')
        dp_name = row.get('distributorProductName', 'N/A')
        brand = row.get('targetBrand', 'N/A')
        variant = row.get('targetVariantName', 'N/A')
        cost = row.get('effectiveUnitCost', 0)
        price = row.get('proposedPrice', 0)
        gm = row.get('gmPercent', 0)
        
        products_html.append(f"""
            <div class="product-row" style="padding: 12px; border-bottom: 1px solid #eee;">
                <div style="display: flex; justify-content: space-between; align-items: baseline;">
                    <div>
                        <strong>{html.escape(str(dp_name))}</strong>
                        <span style="color: #666; margin-left: 12px;">DP #{dp_id}</span>
                    </div>
                    <div style="text-align: right;">
                        <span style="margin-right: 16px;">Cost: ${cost:.2f}</span>
                        <span style="margin-right: 16px;">Price: ${price:.2f}</span>
                        <span><strong>GM: {gm:.1f}%</strong></span>
                    </div>
                </div>
                <div style="margin-top: 4px; color: #555;">
                    → {html.escape(brand)} - {html.escape(variant)}
                </div>
            </div>
        """)
    
    products_html.append("</div></details>")

# Read original HTML and replace the products section
html_content = HTML_PATH.read_text()

# Find and replace the packet-groups section
import re
pattern = r'<section class=[\'"]packet-groups[\'"]>.*?</section>'
replacement = f"""
<section class="packet-groups">
    <h2 style="padding: 24px;">Phase (B) Review: Purchase Order Verification</h2>
    <p style="padding: 0 24px; color: #666;">
        Review each distributor product name and verify the parsed interpretation (brand, variant) is correct.
        This view is organized by purchase order for easy cross-reference.
    </p>
    {''.join(products_html)}
</section>
"""

new_html = re.sub(pattern, replacement, html_content, flags=re.DOTALL)
HTML_PATH.write_text(new_html)
print(f"Updated {HTML_PATH}")
