#!/usr/bin/env python3
"""
Generate Phase D review HTML with full modular UI component integration.

Integrates:
- PriceStepControl (discrete $0.25 adjustments)
- ApprovalToggle (row + group level)
- CompetitorSummary (inline metrics)
- CompetitorDrawer (side panel)
- StateManager (persistence)
- ReviewTreeNav (hierarchical navigation)
"""

import json
import html
from pathlib import Path
from datetime import datetime
from collections import defaultdict

def load_data():
    """Load pending purchases and market research data"""
    base = Path(__file__).parent
    
    with open(base / 'pending_purchases_2026_05_13.json') as f:
        purchases = json.load(f)
    
    with open(base / 'phase_d_market_research.json') as f:
        market_research = json.load(f)
    
    return purchases, market_research

def calculate_statistics(rows):
    """Calculate summary statistics"""
    total_rows = len(rows)
    create_actions = sum(1 for r in rows if r['actionType'] == 'catalog-create')
    link_actions = sum(1 for r in rows if r['actionType'] == 'catalog-link')
    
    price_raises = sum(1 for r in rows if r.get('pricingAction') == 'raise-price')
    price_lowers = sum(1 for r in rows if r.get('pricingAction') == 'lower-price')
    price_keeps = total_rows - price_raises - price_lowers
    
    return {
        'total_rows': total_rows,
        'create_actions': create_actions,
        'link_actions': link_actions,
        'price_raises': price_raises,
        'price_lowers': price_lowers,
        'price_keeps': price_keeps
    }

def group_by_hierarchy(rows, market_research):
    """Group rows by site -> category -> subcategory -> variant -> brand"""
    hierarchy = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(list)))))
    
    for row in rows:
        dpid = row['distributorProductId']
        site = row.get('site', 'Unknown')
        category = row.get('expectedCategory', 'Uncategorized')
        subcategory = row.get('expectedSubcategory', 'Other')
        variant = row.get('targetVariantName', 'Unknown Variant')
        brand = row.get('targetBrand', 'Unknown Brand')
        
        # Enhance row with market research
        research = market_research['products'].get(dpid, {})
        row['marketResearch'] = research
        
        hierarchy[site][category][subcategory][variant][brand].append(row)
    
    return hierarchy

def make_id(text):
    """Create URL-safe ID from text"""
    return text.lower().replace(' ', '-').replace('/', '-').replace('&', 'and')

def format_money(value):
    """Format as currency"""
    if value is None or not isinstance(value, (int, float)):
        return '$?.??'
    return f'${value:.2f}'

def render_competitor_data(row):
    """Extract competitor data for CompetitorSummary and CompetitorDrawer"""
    research = row.get('marketResearch', {})
    lit_alerts = research.get('litAlerts', {})
    matches = lit_alerts.get('matches', [])
    
    if not matches:
        return None
    
    prices = [m.get('pricePostTax') for m in matches if m.get('pricePostTax')]
    if not prices:
        return None
    
    prices_sorted = sorted(prices)
    median = prices_sorted[len(prices_sorted) // 2] if prices_sorted else None
    
    top_competitor = None
    if matches:
        # Find cheapest competitor
        cheapest = min(matches, key=lambda m: m.get('pricePostTax', float('inf')))
        top_competitor = {
            'name': cheapest.get('storeName', 'Unknown'),
            'price': cheapest.get('pricePostTax')
        }
    
    return {
        'median': median,
        'min': min(prices) if prices else None,
        'max': max(prices) if prices else None,
        'avg': lit_alerts.get('averagePrice'),
        'count': len(matches),
        'topCompetitor': top_competitor,
        'matches': matches
    }

def render_pricing_ladder(row, comp_data):
    """Render pricing ladder with markers"""
    current_price = row.get('currentPrice')
    proposed_price = row.get('proposedPrice')
    cost = row.get('effectiveUnitCost')
    
    # Determine domain (min/max for scale)
    prices = [current_price, proposed_price]
    if comp_data:
        if comp_data['min']: prices.append(comp_data['min'])
        if comp_data['max']: prices.append(comp_data['max'])
        if comp_data['median']: prices.append(comp_data['median'])
    
    prices = [p for p in prices if p is not None]
    if not prices:
        return '<div class="muted">No pricing data</div>'
    
    domain_min = min(prices) * 0.9
    domain_max = max(prices) * 1.1
    
    def price_to_percent(price):
        if domain_max <= domain_min:
            return 50
        return ((price - domain_min) / (domain_max - domain_min)) * 100
    
    # Build ladder HTML
    ladder_html = f'<div class="pricing-ladder" data-domain-min="{domain_min:.4f}" data-domain-max="{domain_max:.4f}" data-cost="{cost or 0:.4f}" data-initial-proposed="{proposed_price or 0:.4f}">'
    ladder_html += '<div class="ladder-track"></div>'
    
    # IQR if available
    if comp_data and comp_data.get('min') and comp_data.get('max'):
        q1 = comp_data['min']
        q3 = comp_data['max']
        iqr_left = price_to_percent(q1)
        iqr_width = price_to_percent(q3) - iqr_left
        ladder_html += f'<div class="ladder-iqr" style="left:{iqr_left:.2f}%; width:{iqr_width:.2f}%;"></div>'
    
    # Median marker
    if comp_data and comp_data.get('median'):
        median_left = price_to_percent(comp_data['median'])
        ladder_html += f'<div class="ladder-median" style="left:{median_left:.2f}%;"></div>'
    
    # Current price marker
    if current_price:
        current_left = price_to_percent(current_price)
        current_gm = row.get('currentGmPercent', 0)
        ladder_html += f'<div class="ladder-marker current" style="left:{current_left:.2f}%;" title="Current: {format_money(current_price)}&#10;GM: {current_gm:.2f}%"><span>Current</span></div>'
    
    # Proposed price marker (will be controlled by PriceStepControl)
    if proposed_price:
        proposed_left = price_to_percent(proposed_price)
        proposed_gm = row.get('gmPercent', 0)
        ladder_html += f'<div class="ladder-marker proposed" style="left:{proposed_left:.2f}%;" title="Proposed: {format_money(proposed_price)}&#10;GM: {proposed_gm:.2f}%"><span>Proposed</span></div>'
    
    ladder_html += f'<div class="ladder-axis axis-min">{format_money(domain_min)}</div>'
    ladder_html += f'<div class="ladder-axis axis-max">{format_money(domain_max)}</div>'
    ladder_html += '</div>'
    
    return ladder_html

def render_product_row(row, comp_data):
    """Render a single product row with all integrated controls"""
    dpid = row['distributorProductId']
    variant_name = row.get('targetVariantName', 'Unknown')
    brand = row.get('targetBrand', 'Unknown')
    cost = row.get('effectiveUnitCost')
    proposed_price = row.get('proposedPrice')
    current_price = row.get('currentPrice')
    gm = row.get('gmPercent')
    
    row_id = f"row-{dpid}"
    
    html_parts = []
    html_parts.append(f'<tr class="product-row" data-row-id="{row_id}" data-dpid="{dpid}">')
    
    # Approval cell (will be populated by ApprovalToggle)
    html_parts.append('<td class="approval-cell" data-approval-container></td>')
    
    # Product info
    html_parts.append('<td class="product-info-cell">')
    html_parts.append('<div class="meta-stack">')
    html_parts.append(f'<strong>{html.escape(variant_name)}</strong>')
    html_parts.append(f'<span class="muted">{html.escape(brand)}</span>')
    html_parts.append(f'<span class="muted">Cost: {format_money(cost)}</span>')
    html_parts.append('</div>')
    html_parts.append('</td>')
    
    # Pricing cell
    html_parts.append('<td class="pricing-cell">')
    html_parts.append('<div class="pricing-ladder-shell">')
    html_parts.append('<div class="pricing-ladder-head">')
    html_parts.append(f'<span class="metric">{format_money(current_price)} -> {format_money(proposed_price)} <span class="metric-detail">({gm:.2f}% GM)</span></span>')
    html_parts.append('</div>')
    html_parts.append(render_pricing_ladder(row, comp_data))
    # Price step control will be inserted here by JavaScript
    html_parts.append('<div data-price-control-container></div>')
    html_parts.append('</div>')
    html_parts.append('</td>')
    
    # Competitor summary cell
    html_parts.append('<td class="competitor-cell" data-competitor-container>')
    if comp_data:
        # Will be populated by CompetitorSummary JavaScript
        html_parts.append(f'<div data-competitor-data=\'{json.dumps(comp_data)}\'></div>')
    else:
        html_parts.append('<span class="muted">No competitor data</span>')
    html_parts.append('</td>')
    
    html_parts.append('</tr>')
    
    return '\n'.join(html_parts)

def render_brand_group(brand, rows, site_key, cat_key, sub_key, var_key):
    """Render brand-level group with approval controls"""
    brand_id = f"site-{site_key}-cat-{cat_key}-sub-{sub_key}-var-{var_key}-brand-{make_id(brand)}"
    
    html_parts = []
    html_parts.append(f'<details class="group-block group-brand" data-nav-key="{brand_id}" id="{brand_id}">')
    html_parts.append('<summary>')
    html_parts.append(f'<span class="group-kicker">Brand</span>')
    html_parts.append(f'<strong>{html.escape(brand)}</strong>')
    html_parts.append(f'<span class="group-count">{len(rows)} row{"s" if len(rows) != 1 else ""}</span>')
    # Group approval controls will be inserted here by JavaScript
    html_parts.append(f'<div class="group-actions" data-group-approval-container data-group-id="{brand_id}"></div>')
    html_parts.append('</summary>')
    
    html_parts.append('<div class="group-content">')
    html_parts.append('<table class="group-table">')
    html_parts.append('<thead><tr>')
    html_parts.append('<th>Approval</th>')
    html_parts.append('<th>Product</th>')
    html_parts.append('<th>Pricing</th>')
    html_parts.append('<th>Competitors</th>')
    html_parts.append('</tr></thead>')
    html_parts.append('<tbody>')
    
    for row in rows:
        comp_data = render_competitor_data(row)
        html_parts.append(render_product_row(row, comp_data))
    
    html_parts.append('</tbody>')
    html_parts.append('</table>')
    html_parts.append('</div>')
    html_parts.append('</details>')
    
    return '\n'.join(html_parts)

def render_hierarchy(hierarchy):
    """Render full hierarchical structure"""
    html_parts = []
    
    for site, categories in sorted(hierarchy.items()):
        site_key = make_id(site)
        site_id = f"site-{site_key}"
        site_row_count = sum(len(rows) for cat in categories.values() for sub in cat.values() for var in sub.values() for rows in var.values())
        
        html_parts.append(f'<details class="group-block group-site" data-nav-key="{site_id}" id="{site_id}" open>')
        html_parts.append('<summary>')
        html_parts.append(f'<span class="group-kicker">Site</span>')
        html_parts.append(f'<strong>{html.escape(site)}</strong>')
        html_parts.append(f'<span class="group-count">{site_row_count} rows</span>')
        html_parts.append(f'<div class="group-actions" data-group-approval-container data-group-id="{site_id}"></div>')
        html_parts.append('</summary>')
        html_parts.append('<div class="group-content">')
        
        for category, subcategories in sorted(categories.items()):
            cat_key = make_id(category)
            cat_id = f"{site_id}-cat-{cat_key}"
            cat_row_count = sum(len(rows) for sub in subcategories.values() for var in sub.values() for rows in var.values())
            
            html_parts.append(f'<details class="group-block group-category" data-nav-key="{cat_id}" id="{cat_id}">')
            html_parts.append('<summary>')
            html_parts.append(f'<span class="group-kicker">Category</span>')
            html_parts.append(f'<strong>{html.escape(category)}</strong>')
            html_parts.append(f'<span class="group-count">{cat_row_count} rows</span>')
            html_parts.append(f'<div class="group-actions" data-group-approval-container data-group-id="{cat_id}"></div>')
            html_parts.append('</summary>')
            html_parts.append('<div class="group-content">')
            
            for subcategory, variants in sorted(subcategories.items()):
                sub_key = make_id(subcategory)
                sub_id = f"{cat_id}-sub-{sub_key}"
                sub_row_count = sum(len(rows) for var in variants.values() for rows in var.values())
                
                html_parts.append(f'<details class="group-block group-subcategory" data-nav-key="{sub_id}" id="{sub_id}">')
                html_parts.append('<summary>')
                html_parts.append(f'<span class="group-kicker">Subcategory</span>')
                html_parts.append(f'<strong>{html.escape(subcategory)}</strong>')
                html_parts.append(f'<span class="group-count">{sub_row_count} rows</span>')
                html_parts.append(f'<div class="group-actions" data-group-approval-container data-group-id="{sub_id}"></div>')
                html_parts.append('</summary>')
                html_parts.append('<div class="group-content">')
                
                for variant, brands in sorted(variants.items()):
                    var_key = make_id(variant)
                    var_id = f"{sub_id}-var-{var_key}"
                    var_row_count = sum(len(rows) for rows in brands.values())
                    
                    html_parts.append(f'<details class="group-block group-variant" data-nav-key="{var_id}" id="{var_id}">')
                    html_parts.append('<summary>')
                    html_parts.append(f'<span class="group-kicker">Variant</span>')
                    html_parts.append(f'<strong>{html.escape(variant)}</strong>')
                    html_parts.append(f'<span class="group-count">{var_row_count} rows</span>')
                    html_parts.append(f'<div class="group-actions" data-group-approval-container data-group-id="{var_id}"></div>')
                    html_parts.append('</summary>')
                    html_parts.append('<div class="group-content">')
                    
                    for brand, rows in sorted(brands.items()):
                        html_parts.append(render_brand_group(brand, rows, site_key, cat_key, sub_key, var_key))
                    
                    html_parts.append('</div>')
                    html_parts.append('</details>')
                
                html_parts.append('</div>')
                html_parts.append('</details>')
            
            html_parts.append('</div>')
            html_parts.append('</details>')
        
        html_parts.append('</div>')
        html_parts.append('</details>')
    
    return '\n'.join(html_parts)

def render_tree_nav(hierarchy):
    """Render tree navigation sidebar"""
    nav_parts = []
    
    for site, categories in sorted(hierarchy.items()):
        site_key = make_id(site)
        site_id = f"site-{site_key}"
        site_row_count = sum(len(rows) for cat in categories.values() for sub in cat.values() for var in sub.values() for rows in var.values())
        
        nav_parts.append(f'<details class="review-tree-nav-group" data-nav-key="{site_id}" open>')
        nav_parts.append('<summary><span class="review-tree-nav-summary-row">')
        nav_parts.append(f'<span class="review-tree-nav-summary-label"><strong>Site</strong> {html.escape(site)}</span>')
        nav_parts.append(f'<span class="review-tree-nav-count">{site_row_count} rows</span>')
        nav_parts.append('</span></summary>')
        nav_parts.append('<div class="review-tree-nav-links">')
        nav_parts.append(f'<a href="#{site_id}" class="review-tree-nav-link" data-review-tree-nav-link data-review-tree-nav-target-id="{site_id}">All {html.escape(site)}</a>')
        
        for category, subcategories in sorted(categories.items()):
            cat_key = make_id(category)
            cat_id = f"{site_id}-cat-{cat_key}"
            cat_row_count = sum(len(rows) for sub in subcategories.values() for var in sub.values() for rows in var.values())
            
            nav_parts.append(f'<details class="review-tree-nav-node" data-nav-key="{cat_id}">')
            nav_parts.append('<summary><span class="review-tree-nav-summary-row">')
            nav_parts.append(f'<span class="review-tree-nav-summary-label">{html.escape(category)}</span>')
            nav_parts.append(f'<span class="review-tree-nav-count">{cat_row_count}</span>')
            nav_parts.append('</span></summary>')
            nav_parts.append('<div class="review-tree-nav-links">')
            nav_parts.append(f'<a href="#{cat_id}" class="review-tree-nav-link" data-review-tree-nav-link data-review-tree-nav-target-id="{cat_id}">All {html.escape(category)}</a>')
            
            for subcategory, variants in sorted(subcategories.items()):
                sub_key = make_id(subcategory)
                sub_id = f"{cat_id}-sub-{sub_key}"
                sub_row_count = sum(len(rows) for var in variants.values() for rows in var.values())
                
                nav_parts.append(f'<details class="review-tree-nav-node" data-nav-key="{sub_id}">')
                nav_parts.append('<summary><span class="review-tree-nav-summary-row">')
                nav_parts.append(f'<span class="review-tree-nav-summary-label">{html.escape(subcategory)}</span>')
                nav_parts.append(f'<span class="review-tree-nav-count">{sub_row_count}</span>')
                nav_parts.append('</span></summary>')
                nav_parts.append('<div class="review-tree-nav-links">')
                nav_parts.append(f'<a href="#{sub_id}" class="review-tree-nav-link" data-review-tree-nav-link data-review-tree-nav-target-id="{sub_id}">All {html.escape(subcategory)}</a>')
                
                # Variants and brands
                for variant, brands in sorted(variants.items()):
                    var_key = make_id(variant)
                    var_id = f"{sub_id}-var-{var_key}"
                    var_row_count = sum(len(rows) for rows in brands.values())
                    
                    nav_parts.append(f'<details class="review-tree-nav-node" data-nav-key="{var_id}">')
                    nav_parts.append('<summary><span class="review-tree-nav-summary-row">')
                    nav_parts.append(f'<span class="review-tree-nav-summary-label">{html.escape(variant)}</span>')
                    nav_parts.append(f'<span class="review-tree-nav-count">{var_row_count}</span>')
                    nav_parts.append('</span></summary>')
                    nav_parts.append('<div class="review-tree-nav-links">')
                    nav_parts.append(f'<a href="#{var_id}" class="review-tree-nav-link" data-review-tree-nav-link data-review-tree-nav-target-id="{var_id}">All {html.escape(variant)}</a>')
                    
                    for brand in sorted(brands.keys()):
                        brand_id = f"{var_id}-brand-{make_id(brand)}"
                        brand_row_count = len(brands[brand])
                        nav_parts.append(f'<a href="#{brand_id}" class="review-tree-nav-link" data-review-tree-nav-link data-review-tree-nav-target-id="{brand_id}">{html.escape(brand)} ({brand_row_count})</a>')
                    
                    nav_parts.append('</div>')
                    nav_parts.append('</details>')
                
                nav_parts.append('</div>')
                nav_parts.append('</details>')
            
            nav_parts.append('</div>')
            nav_parts.append('</details>')
        
        nav_parts.append('</div>')
        nav_parts.append('</details>')
    
    return '\n'.join(nav_parts)

def generate_html(purchases, market_research):
    """Generate complete HTML with all integrated components"""
    rows = purchases['rows']
    stats = calculate_statistics(rows)
    hierarchy = group_by_hierarchy(rows, market_research)
    
    # Read modular component JavaScript files
    repo_root = Path(__file__).parent.parent.parent.parent
    base = repo_root / 'ui' / 'controls'
    
    with open(base / 'price-step' / 'priceStepControl.js') as f:
        price_step_js = f.read()
    
    with open(base / 'approval-toggle' / 'approvalToggle.js') as f:
        approval_toggle_js = f.read()
    
    with open(base / 'state-manager' / 'stateManager.js') as f:
        state_manager_js = f.read()
    
    with open(base / 'competitor-summary' / 'competitorSummary.js') as f:
        competitor_summary_js = f.read()
    
    with open(base / 'competitor-drawer' / 'competitorDrawer.js') as f:
        competitor_drawer_js = f.read()
    
    with open(base / 'tree-nav' / 'reviewTreeNav.js') as f:
        tree_nav_js = f.read()
    
    # Start building HTML
    html_doc = f'''<!doctype html>
<html lang='en'>
<head>
  <meta charset='utf-8'>
  <title>Phase D Review - Pending Purchases 2026-05-13</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
'''
    
    # Include base CSS (from template reference, modified)
    html_doc += '''
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
      padding: 0;
      font: 14px/1.55 Georgia, 'Iowan Old Style', serif;
      background: radial-gradient(circle at top, #f6eee0 0%, var(--bg) 65%);
      color: var(--ink);
      display: grid;
      grid-template-columns: 320px 1fr;
      align-items: start;
    }
    body.nav-hidden {
      grid-template-columns: 1fr;
    }
    body.nav-hidden .review-tree-nav {
      display: none;
    }
    a { color: #294f94; }
    code { font-family: 'SFMono-Regular', 'Menlo', monospace; }
    .wrap { max-width: 95%; margin: 0 auto; padding: 16px 24px; }
    .hero, .panel, .group-block {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 18px 40px var(--shadow);
    }
    .hero { padding: 0; overflow: hidden; margin-bottom: 20px; }
    .hero-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      align-items: baseline;
      cursor: pointer;
      list-style: none;
      padding: 16px 18px;
    }
    .hero-content { padding: 0 28px 24px; }
    h1, h2, h3 { margin: 0 0 10px; font-family: 'Palatino', 'Book Antiqua', serif; }
    h1 { font-size: 16pt; }
    h2 { font-size: 17px; }
    h3 { font-size: 15px; }
    .muted { color: var(--muted); }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .summary-card {
      background: rgba(255,255,255,0.68);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px 16px;
    }
    .summary-card strong { display: block; font-size: 24px; }
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
    
    /* Navigation */
    .review-tree-nav {
      position: sticky;
      top: 0;
      align-self: start;
      height: 100vh;
      overflow-y: auto;
      box-sizing: border-box;
      padding: 12px;
      border-right: 1px solid #d8d4cc;
      background: #f7f1e6;
      font-size: 13px;
    }
    .review-tree-nav-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 12px;
    }
    .review-tree-nav-header strong { font-size: 14px; }
    .review-tree-nav-toggle {
      font-size: 11px;
      padding: 4px 8px;
      cursor: pointer;
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 4px;
    }
    .review-tree-nav details { margin-left: 6px; }
    .review-tree-nav summary { cursor: pointer; padding: 2px 0; }
    .review-tree-nav-summary-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .review-tree-nav-summary-label { flex: 1 1 auto; }
    .review-tree-nav-count { font-size: 11px; color: #666; }
    .review-tree-nav-link {
      display: block;
      padding: 1px 4px;
      color: #2d2a26;
      text-decoration: none;
    }
    .review-tree-nav-link:hover { background: #ebe2cf; }
    .review-tree-nav-link.is-active {
      background: #d6c6a6;
      font-weight: 600;
    }
    kbd {
      padding: 1px 4px;
      border: 1px solid #aaa;
      border-bottom-width: 2px;
      border-radius: 3px;
      font-size: 11px;
      background: #fff;
    }
    
    /* Groups */
    .group-block { margin-top: 12px; }
    .group-block summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      align-items: center;
      cursor: pointer;
      list-style: none;
      padding: 16px 18px;
    }
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
    .group-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .group-content { padding: 0 12px 12px; }
    .group-site > summary { background: #efe3cf; border-radius: 20px; }
    .group-category > summary {
      background: rgba(39, 65, 126, 0.06);
      border-radius: 20px;
    }
    .group-subcategory { margin-top: 10px; }
    .group-subcategory > summary {
      background: rgba(97, 68, 120, 0.05);
      border-radius: 16px;
    }
    .group-variant { margin-top: 10px; }
    .group-variant > summary {
      background: rgba(145, 108, 30, 0.05);
      border-radius: 16px;
    }
    .group-brand { margin-top: 10px; }
    .group-brand > summary {
      background: rgba(31, 93, 66, 0.05);
      border-radius: 16px;
    }
    
    /* Tables */
    .group-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      background: transparent;
    }
    .group-table th,
    .group-table td {
      border-bottom: 1px solid var(--line);
      padding: 14px 12px;
      vertical-align: top;
      text-align: left;
    }
    .group-table th {
      background: var(--table-head);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .group-table tr:last-child td { border-bottom: 0; }
    .product-row { cursor: pointer; transition: background 0.15s ease; }
    .product-row:hover { background: rgba(145, 108, 30, 0.05); }
    .meta-stack { display: flex; flex-direction: column; gap: 4px; }
    .metric { font-weight: 700; }
    .metric-detail { font-weight: 400; }
    
    /* Pricing ladder */
    .pricing-ladder-shell { margin-top: 6px; }
    .pricing-ladder-head {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      align-items: baseline;
      margin-bottom: 12px;
    }
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
    .ladder-marker {
      position: absolute;
      top: 32px;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .ladder-marker::before {
      content: '';
      display: block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: currentColor;
      border: 2px solid #fff;
      margin-bottom: 4px;
    }
    .ladder-marker span {
      position: absolute;
      top: 20px;
      white-space: nowrap;
    }
    .ladder-marker.current { color: #6d665b; }
    .ladder-marker.proposed { color: #8a4626; }
    .ladder-axis {
      position: absolute;
      bottom: 0;
      font-size: 11px;
      color: var(--muted);
    }
    .ladder-axis.axis-min { left: 0; }
    .ladder-axis.axis-max { right: 0; }
'''
    
    html_doc += '''
  </style>
</head>
<body>
  <nav class="review-tree-nav" aria-label="Packet navigation">
    <div class="review-tree-nav-header">
      <div>
        <strong>Packet</strong>
        <div class="muted">Site → Category → Subcategory → Variant → Brand. Press <kbd>Esc</kbd> to toggle.</div>
      </div>
      <button type="button" class="review-tree-nav-toggle" data-review-tree-nav-hide>Hide nav</button>
    </div>
    <div class="review-tree-nav-tree">
'''
    
    html_doc += render_tree_nav(hierarchy)
    
    html_doc += '''
    </div>
  </nav>
  
  <div class="wrap">
    <details class="hero" open>
      <summary class="hero-summary">
        <h1>Phase D Review - Pending Purchases 2026-05-13</h1>
        <span class="muted">Interactive pricing review with modular controls</span>
      </summary>
      <div class="hero-content">
        <h2>Summary</h2>
        <div class="summary-grid">
'''
    
    html_doc += f'''
          <div class="summary-card">
            <strong>{stats['total_rows']}</strong>
            <span class="muted">Total Products</span>
          </div>
          <div class="summary-card">
            <strong>{stats['create_actions']}</strong>
            <span class="muted">Create Actions</span>
          </div>
          <div class="summary-card">
            <strong>{stats['link_actions']}</strong>
            <span class="muted">Link Actions</span>
          </div>
          <div class="summary-card">
            <strong>{stats['price_raises']}</strong>
            <span class="muted">Price Raises</span>
          </div>
          <div class="summary-card">
            <strong>{stats['price_lowers']}</strong>
            <span class="muted">Price Lowers</span>
          </div>
          <div class="summary-card">
            <strong>{stats['price_keeps']}</strong>
            <span class="muted">Price Keeps</span>
          </div>
'''
    
    html_doc += '''
        </div>
        <p class="muted" style="margin-top: 18px;">
          Use discrete price controls (±$0.25 buttons) to adjust pricing. Approve/reject at any hierarchy level.
          Click "View competitors" to see detailed market data in the side drawer. All changes auto-save.
        </p>
      </div>
    </details>
    
    <section class="packet-groups">
'''
    
    html_doc += render_hierarchy(hierarchy)
    
    html_doc += '''
    </section>
  </div>
  
  <script>
// Embedded modular components
'''
    
    html_doc += price_step_js + '\n\n'
    html_doc += approval_toggle_js + '\n\n'
    html_doc += state_manager_js + '\n\n'
    html_doc += competitor_summary_js + '\n\n'
    html_doc += competitor_drawer_js + '\n\n'
    html_doc += tree_nav_js + '\n\n'
    
    html_doc += '''
// Initialize application
(function() {
  'use strict';
  
  // Initialize state manager
  const stateManager = StateManager.create({
    storageKey: 'phase-d-review-2026-05-13',
    autoSaveDelay: 2000,
    onStateChange: (state) => {
      updateSubmitBar();
    }
  });
  
  // Initialize tree navigation
  ReviewTreeNavControl.init({
    root: document,
    navStorageKey: 'phase-d-nav-state',
    sidebarStorageKey: 'phase-d-sidebar-state'
  });
  
  // Initialize competitor drawer (singleton)
  const competitorDrawer = CompetitorDrawer.create();
  
  // Initialize all approval toggles (row level)
  document.querySelectorAll('[data-approval-container]').forEach(container => {
    const row = container.closest('.product-row');
    if (!row) return;
    
    const rowId = row.getAttribute('data-row-id');
    const dpid = row.getAttribute('data-dpid');
    
    const toggle = ApprovalToggle.create({
      variant: 'row',
      initialState: stateManager.getApproval(rowId),
      onChange: (newState) => {
        stateManager.setApproval(rowId, newState);
        row.setAttribute('data-approval-state', newState);
      }
    });
    
    container.appendChild(toggle);
  });
  
  // Initialize all group approval toggles
  document.querySelectorAll('[data-group-approval-container]').forEach(container => {
    const groupId = container.getAttribute('data-group-id');
    const group = container.closest('.group-block');
    if (!group) return;
    
    // Get all child rows
    const rows = Array.from(group.querySelectorAll('.product-row'));
    const rowIds = rows.map(r => r.getAttribute('data-row-id')).filter(Boolean);
    
    const toggle = ApprovalToggle.create({
      variant: 'group',
      initialState: stateManager.getApproval(groupId) || 'pending',
      label: groupId,
      onChange: (newState) => {
        stateManager.setGroupApproval(groupId, newState, true, rowIds);
        // Update child row visuals
        rows.forEach(row => {
          const rowToggle = row.querySelector('[data-approval-container] .approval-toggle');
          if (rowToggle && rowToggle._api) {
            rowToggle._api.setState(newState);
          }
          row.setAttribute('data-approval-state', newState);
        });
      }
    });
    
    container.appendChild(toggle);
  });
  
  // Initialize all price step controls
  document.querySelectorAll('[data-price-control-container]').forEach(container => {
    const row = container.closest('.product-row');
    if (!row) return;
    
    const rowId = row.getAttribute('data-row-id');
    const ladder = row.querySelector('.pricing-ladder');
    if (!ladder) return;
    
    const proposedMarker = ladder.querySelector('.ladder-marker.proposed');
    if (!proposedMarker) return;
    
    const domainMin = parseFloat(ladder.getAttribute('data-domain-min'));
    const domainMax = parseFloat(ladder.getAttribute('data-domain-max'));
    const cost = parseFloat(ladder.getAttribute('data-cost'));
    const initialProposed = parseFloat(ladder.getAttribute('data-initial-proposed'));
    
    // Check for saved price override
    const savedPrice = stateManager.getPrice(rowId);
    const startPrice = savedPrice ? savedPrice.value : initialProposed;
    
    const priceControl = PriceStepControl.create({
      initialPrice: startPrice,
      min: 0,
      max: domainMax * 1.5,
      onChange: (newPrice) => {
        // Update marker position
        const leftPct = PriceStepControl.priceToLeftPercent(newPrice, domainMin, domainMax);
        proposedMarker.style.left = leftPct.toFixed(2) + '%';
        
        // Update GM calculation
        const gm = PriceStepControl.calculateGM(newPrice, cost);
        const gmText = gm !== null ? gm.toFixed(2) + '% GM' : 'GM unavailable';
        
        // Update marker tooltip
        proposedMarker.setAttribute('title',
          'Proposed: ' + PriceStepControl.formatMoney(newPrice) + '\\n' +
          'GM: ' + gmText
        );
        
        // Update head metric
        const shell = ladder.closest('.pricing-ladder-shell');
        if (shell) {
          const head = shell.querySelector('.pricing-ladder-head .metric');
          if (head) {
            const currentText = (head.textContent || '').split('->')[0].trim();
            head.innerHTML = currentText + ' -> ' + PriceStepControl.formatMoney(newPrice) +
              ' <span class="metric-detail">(' + gmText + ')</span>';
          }
        }
        
        // Save to state
        stateManager.setPrice(rowId, newPrice, { overridden: true });
      }
    });
    
    container.appendChild(priceControl);
  });
  
  // Initialize all competitor summaries
  document.querySelectorAll('[data-competitor-container]').forEach(container => {
    const dataEl = container.querySelector('[data-competitor-data]');
    if (!dataEl) return;
    
    const row = container.closest('.product-row');
    const dpid = row ? row.getAttribute('data-dpid') : null;
    
    try {
      const compData = JSON.parse(dataEl.getAttribute('data-competitor-data'));
      
      const summary = CompetitorSummary.create(compData, {
        onViewDetails: () => {
          const variantName = row.querySelector('.meta-stack strong');
          const title = variantName ? variantName.textContent : 'Product Details';
          
          competitorDrawer.setTitle(title);
          competitorDrawer.open({
            summary: {
              median: compData.median,
              avg: compData.avg,
              min: compData.min,
              max: compData.max
            },
            competitors: compData.matches.map(m => ({
              storeName: m.storeName,
              price: m.pricePostTax,
              brand: m.brand,
              category: m.category,
              weight: m.weight,
              distance: m.distance || 'statewide',
              url: m.url
            }))
          });
        }
      });
      
      dataEl.remove();
      container.appendChild(summary);
    } catch (e) {
      console.error('Failed to parse competitor data:', e);
    }
  });
  
  // Submit bar
  const submitBar = document.createElement('div');
  submitBar.className = 'submit-bar';
  submitBar.innerHTML = `
    <div class="submit-bar-inner">
      <span class="submit-bar-summary">No changes yet</span>
      <button type="button" class="submit-bar-btn submit-export">Export changes</button>
      <button type="button" class="submit-bar-btn submit-reset">Reset all</button>
    </div>
  `;
  document.body.appendChild(submitBar);
  
  // Submit bar styles
  const submitBarStyle = document.createElement('style');
  submitBarStyle.textContent = `
    .submit-bar {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 100;
      background: #2d2a26;
      color: #f5efe1;
      border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.25);
      font-size: 13px;
    }
    .submit-bar.has-changes { background: #2f6f2f; }
    .submit-bar-inner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
    }
    .submit-bar-summary { padding-right: 8px; }
    .submit-bar-btn {
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      background: #f5efe1;
      color: #2d2a26;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    .submit-bar-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .submit-bar-btn:hover:not(:disabled) { background: #fff; }
  `;
  document.head.appendChild(submitBarStyle);
  
  function updateSubmitBar() {
    const stats = stateManager.getStatistics();
    const totalChanges = stats.priceOverrides + stats.approvals.approved + stats.approvals.rejected;
    
    const summary = submitBar.querySelector('.submit-bar-summary');
    const exportBtn = submitBar.querySelector('.submit-export');
    
    if (totalChanges === 0) {
      summary.textContent = 'No changes yet';
      exportBtn.disabled = true;
      submitBar.classList.remove('has-changes');
    } else {
      const parts = [];
      if (stats.priceOverrides > 0) parts.push(stats.priceOverrides + ' price' + (stats.priceOverrides === 1 ? '' : 's'));
      if (stats.approvals.approved > 0) parts.push(stats.approvals.approved + ' approved');
      if (stats.approvals.rejected > 0) parts.push(stats.approvals.rejected + ' rejected');
      summary.textContent = parts.join(', ') + ' • Auto-saved';
      exportBtn.disabled = false;
      submitBar.classList.add('has-changes');
    }
  }
  
  submitBar.querySelector('.submit-export').addEventListener('click', () => {
    const exported = stateManager.exportState();
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'phase_d_review_changes_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
  
  submitBar.querySelector('.submit-reset').addEventListener('click', () => {
    if (!confirm('Reset all changes? This will clear all approvals and price overrides.')) return;
    stateManager.reset();
    window.location.reload();
  });
  
  updateSubmitBar();
})();
  </script>
</body>
</html>
'''
    
    return html_doc

def main():
    purchases, market_research = load_data()
    html = generate_html(purchases, market_research)
    
    output_path = Path(__file__).parent / 'phase_d_review_integrated.html'
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html)
    
    print(f"Generated: {output_path}")
    print(f"File size: {len(html):,} bytes")
    
    return output_path

if __name__ == '__main__':
    main()
