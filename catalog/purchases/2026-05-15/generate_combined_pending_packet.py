#!/usr/bin/env python3
"""Combined pending-purchases catalog mutation proposal for 2026-05-14.

This generator follows the standing meaning of `produce pending purchases
proposal` recorded at
`docs/sweed/catalog/produce-pending-purchase-proposal.md`. It:

  * pulls live pending purchases from Midtown (210705) and Bronx (210249),
  * builds proposal rows using the legacy 2026-04-13 pipeline with two
    runtime patches (`_legacy_patches.install_patches`):
      - `parse_product_name` consults the LLM-pre-warmed cache so distributor
        SKUs the legacy parsers don't recognize (e.g. `BS Ice Cream Swirl 14g`,
        `MZ ... Live Rosin Vape .5g`, `1O-...` Herb codes) decode correctly;
      - per-row pricing for brands co-located on the Stop 31 LLC Midtown order
        is overridden to the top of the MSO band (67.5% GM) so marketing can
        adjust via promo discounts.
  * applies a brand MSO classification with default-non-MSO + reviewer flag,
  * renders one HTML packet with site -> category -> subcategory -> variant ->
    brand grouping, a draggable proposed-price marker on every price ladder,
    and the shared left tree-nav (`ui/controls/tree-nav/`) with `Escape`-toggle.

Outputs into the current directory:
  phase_d_full_packet.{json,html}
  phase_d_full_packet_details/<DP>.html
"""

from __future__ import annotations

import html
import json
import shutil
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_ROOT = WORKDIR.parents[2]
LEGACY_DIR = AUTOMATION_ROOT / "categories" / "2026-04-13"
TREE_NAV_DIR = AUTOMATION_ROOT / "ui" / "controls" / "tree-nav"

if str(LEGACY_DIR) not in sys.path:
    sys.path.insert(0, str(LEGACY_DIR))
if str(WORKDIR) not in sys.path:
    sys.path.insert(0, str(WORKDIR))

import generate_pending_order_catalog_proposal as g  # noqa: E402
import _legacy_patches as patches  # noqa: E402

patches.install_patches(g)

OUTPUT_STEM = "phase_d_full_packet"
OUTPUT_JSON = WORKDIR / f"{OUTPUT_STEM}.json"
OUTPUT_HTML = WORKDIR / f"{OUTPUT_STEM}.html"
OUTPUT_DETAIL_DIR = WORKDIR / f"{OUTPUT_STEM}_details"

SITES = [
    {
        "siteKey": "midtown",
        "siteLabel": "Midtown",
        "siteDealerName": "Freshly Baked NYC - Midtown",
        "siteDealerId": 210705,
    },
    {
        "siteKey": "bronx",
        "siteLabel": "Bronx",
        "siteDealerName": "Freshly Baked NYC - The Bronx",
        "siteDealerId": 210249,
    },
]

# Brand MSO classification. We have no `module_annotations` table available in
# this workspace yet, so we default every brand to non-MSO and surface that as
# a reviewer flag per the canonical spec. Operators can override this map as
# the annotations source comes online.
KNOWN_MSO_BRANDS: set[str] = set()


# --------------------------------------------------------------------------------------
# Per-site collection
# --------------------------------------------------------------------------------------

def collect_for_site(site: dict) -> tuple[list[dict], list[dict]]:
    """Switch dealer context and run the legacy pending-group collector."""
    g.configure_runtime(site["siteKey"], output_stem=f"{site['siteKey']}_pending_2026-05-14")
    orders, groups = g.collect_pending_groups()
    print(
        f"[collect] site={site['siteLabel']} dealer={site['siteDealerId']}  "
        f"orders={len(orders)} unmapped-positions={sum(o['unresolvedPositionCount'] for o in orders)}  "
        f"groups={len(groups)}",
        flush=True,
    )
    return orders, groups


def build_rows_for_site(site: dict, groups: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for group in groups:
        try:
            row = g.build_row(group)
        except Exception as exc:  # noqa: BLE001
            # No silent failures per the canonical spec.
            print(
                f"[build_row][FAIL] site={site['siteLabel']} dp={group['distributorProductId']} "
                f"name={group['distributorProductName']!r}: {exc}",
                flush=True,
            )
            raise
        # Apply the per-brand GM-target override (Herb-co-located brands ->
        # 67.5% GM). Pure no-op for brands not in the override map.
        row = patches.apply_brand_gm_override(row, g)
        # Stamp site context onto every row so downstream renderers can group
        # by site without re-querying.
        row["_siteKey"] = site["siteKey"]
        row["_siteLabel"] = site["siteLabel"]
        row["_siteDealerName"] = site["siteDealerName"]
        # Stamp MSO classification + reviewer flag if missing.
        brand = patches.normalize_brand(row.get("targetBrand"))
        is_mso = brand in KNOWN_MSO_BRANDS
        row["brandMsoClassification"] = "MSO" if is_mso else "non-MSO"
        if not is_mso:
            flags = list(row.get("reviewFlags") or [])
            mso_flag = "Brand MSO classification defaulted to non-MSO (no annotation source available)"
            if mso_flag not in flags:
                flags.append(mso_flag)
            row["reviewFlags"] = flags
        rows.append(row)
        print(
            f"  [row] {site['siteLabel']:8} {row['targetBrand']:24} "
            f"{row['targetVariantName']:55} cost={row['effectiveUnitCost']!s:>7}  "
            f"price={row['proposedPrice']!s:>7}  GM={row['gmPercent']!s:>6}",
            flush=True,
        )
    return rows


# --------------------------------------------------------------------------------------
# Detail pages
# --------------------------------------------------------------------------------------

def write_detail_pages(rows: list[dict]) -> None:
    OUTPUT_DETAIL_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUTPUT_DETAIL_DIR.glob("*.html"):
        old.unlink()
    g.OUTPUT_DETAIL_DIR = OUTPUT_DETAIL_DIR
    for row in rows:
        (OUTPUT_DETAIL_DIR / g.detail_page_filename(row)).write_text(g.render_detail_page(row))


# --------------------------------------------------------------------------------------
# Tree nav and combined renderer
# --------------------------------------------------------------------------------------

def slugify(value: str) -> str:
    out = []
    for ch in (value or "").lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-") or "node"


def hierarchy_for_rows(rows: list[dict]) -> dict:
    tree: dict = defaultdict(
        lambda: defaultdict(
            lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
        )
    )
    for row in rows:
        site_label = row["_siteLabel"]
        category = row["expectedCategory"] or "Uncategorized"
        subcategory = row["expectedSubcategory"] or "Unspecified"
        variant = row["targetVariantName"]
        brand = row["targetBrand"]
        tree[site_label][category][subcategory][variant][brand].append(row)
    return tree


def render_tree_nav(rows: list[dict]) -> str:
    tree = hierarchy_for_rows(rows)
    parts = ['<nav class="review-tree-nav" aria-label="Packet navigation">']
    parts.append('<div class="review-tree-nav-header">')
    parts.append('<div><strong>Packet</strong><div class="muted">Site - Category - Subcategory - Variant - Brand. Press <kbd>Esc</kbd> to toggle.</div></div>')
    parts.append('<button type="button" class="review-tree-nav-toggle" data-review-tree-nav-hide>Hide nav</button>')
    parts.append('</div>')
    parts.append('<div class="review-tree-nav-tree">')
    for site_label, cat_map in sorted(tree.items()):
        site_id = f"site-{slugify(site_label)}"
        site_count = sum(
            len(b)
            for cm in cat_map.values()
            for sm in cm.values()
            for vm in sm.values()
            for b in vm.values()
        )
        parts.append(f'<details class="review-tree-nav-group" data-nav-key="{site_id}" open>')
        parts.append(
            f'<summary><span class="review-tree-nav-summary-row">'
            f'<span class="review-tree-nav-summary-label"><strong>Site</strong> {html.escape(site_label)}</span>'
            f'<span class="review-tree-nav-count">{site_count} row{"s" if site_count != 1 else ""}</span>'
            '</span></summary>'
        )
        parts.append('<div class="review-tree-nav-links">')
        parts.append(
            f'<a href="#{site_id}" class="review-tree-nav-link" data-review-tree-nav-link data-review-tree-nav-target-id="{site_id}">All {html.escape(site_label)}</a>'
        )
        for category, sub_map in sorted(cat_map.items()):
            cat_id = f"{site_id}-cat-{slugify(category)}"
            cat_count = sum(len(b) for sm in sub_map.values() for vm in sm.values() for b in vm.values())
            parts.append(f'<details class="review-tree-nav-node" data-nav-key="{cat_id}">')
            parts.append(
                f'<summary><span class="review-tree-nav-summary-row">'
                f'<span class="review-tree-nav-summary-label">{html.escape(category)}</span>'
                f'<span class="review-tree-nav-count">{cat_count}</span>'
                '</span></summary>'
            )
            parts.append('<div class="review-tree-nav-links">')
            parts.append(
                f'<a href="#{cat_id}" class="review-tree-nav-link" data-review-tree-nav-link data-review-tree-nav-target-id="{cat_id}">All {html.escape(category)}</a>'
            )
            for subcategory, variant_map in sorted(sub_map.items()):
                sub_id = f"{cat_id}-sub-{slugify(subcategory)}"
                sub_count = sum(len(b) for vm in variant_map.values() for b in vm.values())
                parts.append(f'<details class="review-tree-nav-node" data-nav-key="{sub_id}">')
                parts.append(
                    f'<summary><span class="review-tree-nav-summary-row">'
                    f'<span class="review-tree-nav-summary-label">{html.escape(subcategory)}</span>'
                    f'<span class="review-tree-nav-count">{sub_count}</span>'
                    '</span></summary>'
                )
                parts.append('<div class="review-tree-nav-links">')
                parts.append(
                    f'<a href="#{sub_id}" class="review-tree-nav-link" data-review-tree-nav-link data-review-tree-nav-target-id="{sub_id}">All {html.escape(subcategory)}</a>'
                )
                for variant, brand_map in sorted(variant_map.items()):
                    var_id = f"{sub_id}-var-{slugify(variant)}"
                    var_count = sum(len(b) for b in brand_map.values())
                    parts.append(f'<details class="review-tree-nav-node" data-nav-key="{var_id}">')
                    parts.append(
                        f'<summary><span class="review-tree-nav-summary-row">'
                        f'<span class="review-tree-nav-summary-label">{html.escape(variant)}</span>'
                        f'<span class="review-tree-nav-count">{var_count}</span>'
                        '</span></summary>'
                    )
                    parts.append('<div class="review-tree-nav-links">')
                    parts.append(
                        f'<a href="#{var_id}" class="review-tree-nav-link" data-review-tree-nav-link data-review-tree-nav-target-id="{var_id}">All {html.escape(variant)}</a>'
                    )
                    for brand, brand_rows in sorted(brand_map.items()):
                        brand_id = f"{var_id}-brand-{slugify(brand)}"
                        parts.append(
                            f'<a href="#{brand_id}" class="review-tree-nav-link" data-review-tree-nav-link data-review-tree-nav-target-id="{brand_id}">{html.escape(brand)} ({len(brand_rows)})</a>'
                        )
                    parts.append('</div>')
                    parts.append('</details>')
                parts.append('</div>')
                parts.append('</details>')
            parts.append('</div>')
            parts.append('</details>')
        parts.append('</div>')
        parts.append('</details>')
    parts.append('</div>')
    parts.append('</nav>')
    return "\n".join(parts)


def render_grouped_packet_with_anchors(rows: list[dict]) -> str:
    tree = hierarchy_for_rows(rows)
    sections: list[str] = []
    for site_label, cat_map in sorted(tree.items()):
        site_id = f"site-{slugify(site_label)}"
        site_count = sum(
            len(b)
            for cm in cat_map.values()
            for sm in cm.values()
            for vm in sm.values()
            for b in vm.values()
        )
        cat_blocks: list[str] = []
        for category, sub_map in sorted(cat_map.items()):
            cat_id = f"{site_id}-cat-{slugify(category)}"
            cat_count = sum(len(b) for sm in sub_map.values() for vm in sm.values() for b in vm.values())
            sub_blocks: list[str] = []
            for subcategory, variant_map in sorted(sub_map.items()):
                sub_id = f"{cat_id}-sub-{slugify(subcategory)}"
                sub_count = sum(len(b) for vm in variant_map.values() for b in vm.values())
                var_blocks: list[str] = []
                for variant, brand_map in sorted(variant_map.items()):
                    var_id = f"{sub_id}-var-{slugify(variant)}"
                    var_count = sum(len(b) for b in brand_map.values())
                    brand_blocks: list[str] = []
                    for brand, brand_rows in sorted(brand_map.items()):
                        brand_id = f"{var_id}-brand-{slugify(brand)}"
                        brand_blocks.append(f"""
                            <details class="group-block group-brand" id="{brand_id}" open>
                              <summary>
                                <span class="group-kicker">Brand</span>
                                <strong>{html.escape(brand)}</strong>
                                <span class="group-count">{len(brand_rows)} row{'s' if len(brand_rows) != 1 else ''}</span>
                              </summary>
                              <div class="group-content">
                                {g.render_brand_table(brand_rows)}
                                {g.group_footer('Brand')}
                              </div>
                            </details>
                        """)
                    var_blocks.append(f"""
                        <details class="group-block group-variant" id="{var_id}" open>
                          <summary>
                            <span class="group-kicker">Variant</span>
                            <strong>{html.escape(variant)}</strong>
                            <span class="group-count">{var_count} row{'s' if var_count != 1 else ''}</span>
                          </summary>
                          <div class="group-content">
                            {''.join(brand_blocks)}
                            {g.group_footer('Variant')}
                          </div>
                        </details>
                    """)
                sub_blocks.append(f"""
                    <details class="group-block group-subcategory" id="{sub_id}" open>
                      <summary>
                        <span class="group-kicker">Subcategory</span>
                        <strong>{html.escape(subcategory)}</strong>
                        <span class="group-count">{sub_count} row{'s' if sub_count != 1 else ''}</span>
                      </summary>
                      <div class="group-content">
                        {''.join(var_blocks)}
                        {g.group_footer('Subcategory')}
                      </div>
                    </details>
                """)
            cat_blocks.append(f"""
                <details class="group-block group-category" id="{cat_id}" open>
                  <summary>
                    <span class="group-kicker">Category</span>
                    <strong>{html.escape(category)}</strong>
                    <span class="group-count">{cat_count} row{'s' if cat_count != 1 else ''}</span>
                  </summary>
                  <div class="group-content">
                    {''.join(sub_blocks)}
                    {g.group_footer('Category')}
                  </div>
                </details>
            """)
        sections.append(f"""
            <details class="group-block group-site" id="{site_id}" open>
              <summary>
                <span class="group-kicker">Site</span>
                <strong>{html.escape(site_label)}</strong>
                <span class="group-count">{site_count} row{'s' if site_count != 1 else ''}</span>
              </summary>
              <div class="group-content">
                {''.join(cat_blocks)}
                {g.group_footer('Site')}
              </div>
            </details>
        """)
    return "".join(sections)


def render_orders_table(orders: list[dict]) -> str:
    rows_html = []
    for order in orders:
        rows_html.append(
            "<tr>"
            f"<td>{order.get('orderId') or '-'}</td>"
            f"<td>{html.escape(str(order.get('externalOrderId') or '-'))}</td>"
            f"<td>{html.escape(str(order.get('distributor') or '-'))}</td>"
            f"<td>{html.escape(str(order.get('deliveryDate') or '-'))}</td>"
            f"<td>{order.get('positionCount') or '-'}</td>"
            f"<td>{order.get('unresolvedPositionCount') or '-'}</td>"
            "</tr>"
        )
    if not rows_html:
        rows_html.append('<tr><td colspan="6" class="muted">No live pending-purchase orders.</td></tr>')
    return "".join(rows_html)


# --------------------------------------------------------------------------------------
# CSS for the additions (tree-nav sidebar + draggable proposed marker)
# --------------------------------------------------------------------------------------

EXTRA_STYLES = """
  body { display: grid; grid-template-columns: 320px 1fr; align-items: start; }
  body.nav-hidden { grid-template-columns: 0 1fr; }
  body.nav-hidden .review-tree-nav { display: none; }
  .review-tree-nav {
    position: sticky; top: 0; align-self: start;
    height: 100vh; overflow-y: auto; box-sizing: border-box;
    padding: 12px; border-right: 1px solid #d8d4cc;
    background: #f7f1e6; font-size: 13px;
  }
  .review-tree-nav-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
  .review-tree-nav-header strong { font-size: 14px; }
  .review-tree-nav-toggle { font-size: 11px; padding: 4px 8px; cursor: pointer; }
  .review-tree-nav details { margin-left: 6px; }
  .review-tree-nav summary { cursor: pointer; padding: 2px 0; }
  .review-tree-nav-summary-row { display: flex; justify-content: space-between; gap: 8px; }
  .review-tree-nav-summary-label { flex: 1 1 auto; }
  .review-tree-nav-count { font-size: 11px; color: #666; }
  .review-tree-nav-link { display: block; padding: 1px 4px; color: #2d2a26; text-decoration: none; }
  .review-tree-nav-link:hover { background: #ebe2cf; }
  .review-tree-nav-link.is-active { background: #d6c6a6; font-weight: 600; }
  .review-tree-nav-show {
    position: fixed; top: 8px; left: 8px; z-index: 50;
    padding: 6px 10px; font-size: 12px; cursor: pointer;
    background: #f7f1e6; border: 1px solid #d8d4cc; border-radius: 4px;
    display: none;
  }
  body.nav-hidden .review-tree-nav-show { display: block; }
  .wrap { padding: 16px 24px; }

  /* Draggable proposed-price marker */
  .pricing-ladder { position: relative; }
  .pricing-ladder .ladder-marker.proposed {
    cursor: ew-resize; user-select: none;
    transition: transform 0.05s ease;
  }
  .pricing-ladder .ladder-marker.proposed.is-dragging {
    transform: translate(-50%, -50%) scale(1.15);
    box-shadow: 0 0 0 3px rgba(106, 73, 17, 0.25);
  }

  kbd { padding: 1px 4px; border: 1px solid #aaa; border-bottom-width: 2px; border-radius: 3px; font-size: 11px; background: #fff; }

  /* Floating submit bar */
  .submit-bar {
    position: fixed; right: 16px; bottom: 16px; z-index: 100;
    background: #2d2a26; color: #f5efe1; border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.25);
    font-size: 13px;
  }
  .submit-bar.has-changes { background: #2f6f2f; }
  .submit-bar-inner { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
  .submit-bar-summary { padding-right: 8px; }
  .submit-bar-btn {
    padding: 6px 12px; font-size: 12px; font-weight: 600;
    background: #f5efe1; color: #2d2a26; border: none; border-radius: 4px; cursor: pointer;
  }
  .submit-bar-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .submit-bar-btn:hover:not(:disabled) { background: #fff; }
"""


# --------------------------------------------------------------------------------------
# Combined HTML
# --------------------------------------------------------------------------------------

PACKET_TITLE = "Combined pending-purchases catalog mutation proposal - 2026-05-14"


def render_html(rows: list[dict], orders: list[dict]) -> str:
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    action_counts: dict[str, int] = defaultdict(int)
    category_counts: dict[str, int] = defaultdict(int)
    for r in rows:
        action_counts[r["actionType"]] += 1
        category_counts[r["expectedCategory"]] += 1
    image_coverage = sum(1 for r in rows if r.get("primaryImageUrl"))
    missing_lit = sum(1 for r in rows if (r.get("litAlertsMatchCount") or 0) == 0)
    thin_lit = sum(1 for r in rows if 0 < (r.get("litAlertsMatchCount") or 0) < 3)
    missing_price = sum(1 for r in rows if r.get("proposedPrice") is None)
    overrides = sum(1 for r in rows if "Brand GM-target override applied" in (r.get("reviewFlags") or []))
    mso_default = sum(1 for r in rows if r.get("brandMsoClassification") == "non-MSO")
    category_mix = ", ".join(
        f"{c}: {n}" for c, n in sorted(category_counts.items(), key=lambda i: i[0].lower())
    )
    warnings = [
        f"{missing_lit} row(s) still have no Lit Alerts evidence after the current statewide filter.",
        f"{thin_lit} row(s) only have thin Lit Alerts evidence (<3 matches).",
        f"{missing_price} row(s) still need a manual draft price.",
        f"{len(rows) - image_coverage} row(s) still have no embedded reviewer image.",
        f"{overrides} row(s) had the Stop 31 LLC brand GM-target override applied (priced at 67.5% GM).",
        f"{mso_default} row(s) have brand MSO classification defaulted to non-MSO (no annotation source available).",
    ]

    tree_nav_html = render_tree_nav(rows)
    grouped_html = render_grouped_packet_with_anchors(rows)
    orders_table = render_orders_table(orders)
    site_count = len({r["_siteLabel"] for r in rows})

    # Embed shared tree-nav runtime client.
    tree_nav_runtime = (TREE_NAV_DIR / "reviewTreeNav.js").read_text()

    return f"""<!doctype html>
<html lang='en'>
<head>
  <meta charset='utf-8'>
  <title>{html.escape(PACKET_TITLE)}</title>
  <style>
{g.HTML_STYLE_BLOCK}
  .group-site > summary {{ background: #efe3cf; }}
{EXTRA_STYLES}
  </style>
</head>
<body>
  {tree_nav_html}
  <button type="button" class="review-tree-nav-show" data-review-tree-nav-show>Show nav</button>
  <div class='wrap'>
    <details class='hero' open>
      <summary class='hero-summary'>
        <span class='group-kicker'>Packet Header</span>
        <h1>{html.escape(PACKET_TITLE)}</h1>
        <span class='group-count'>Show packet summary, draft status, and audit scope</span>
      </summary>
      <div class='hero-content'>
        <p class='muted'>Combined review packet for live pending-purchase rows from Midtown and Bronx. Catalog inspection runs from the <strong>Freshly Baked NY</strong> state dealer; per-site pending-purchase reads run from each site's own dealer context. The legacy parser pipeline is augmented with a Mantle-backed LLM cache so distributor SKUs the legacy regex parsers can't decode (Booty Shake `BS ...`, Dr Jekyll &amp; Mr High `J&amp;H ...`, Moony's Zooties `MZ ...`, Herb `1O-...`, Doobie Labs / Jungle Girl / Moonlit / Purps / Runtz / Smartbud / Strain Gang abbreviations) decode deterministically. All rows are reviewer-facing - this packet does NOT perform any live catalog write.</p>
        <p class='muted'>Pricing for every brand co-located on the Stop 31 LLC Midtown order (131845) is set to the <strong>top of the MSO band (67.5% GM)</strong> per operator directive on 2026-05-14; promo discounts are expected to drop the customer-facing price for marketing.</p>
        <div class='summary-grid'>
          <div class='summary-card'><span class='muted'>Sites in scope</span><strong>{site_count}</strong></div>
          <div class='summary-card'><span class='muted'>Pending-purchase orders</span><strong>{len(orders)}</strong></div>
          <div class='summary-card'><span class='muted'>Total rows</span><strong>{len(rows)}</strong></div>
          <div class='summary-card'><span class='muted'>Catalog-create rows</span><strong>{action_counts['catalog-create']}</strong></div>
          <div class='summary-card'><span class='muted'>Mapping-only rows</span><strong>{action_counts['mapping-only']}</strong></div>
          <div class='summary-card'><span class='muted'>GM-target overrides</span><strong>{overrides}</strong></div>
          <div class='summary-card'><span class='muted'>Embedded images</span><strong>{image_coverage} / {len(rows)}</strong></div>
        </div>
        <div class='banner-row'>
          <div class='callout danger'>
            <h2>Draft Status</h2>
            <p class='muted'>Treat this packet as a reviewer-facing proposal, not an auto-approval. Drag the <strong>proposed</strong> marker on any price ladder to override per row; the GM% updates live. Press <kbd>Esc</kbd> to toggle the left tree-nav.</p>
            <ul class='flag-list'>
              {''.join(f'<li>{html.escape(w)}</li>' for w in warnings)}
            </ul>
          </div>
          <div class='callout'>
            <h2>Audit Scope</h2>
            <div class='audit-grid'>
              <div class='audit-card'><span class='muted'>Generated</span><strong>{html.escape(generated_at)}</strong></div>
              <div class='audit-card'><span class='muted'>Category mix</span><strong>{html.escape(category_mix)}</strong></div>
              <div class='audit-card'><span class='muted'>Sites</span><strong>{html.escape(', '.join(sorted({r['_siteLabel'] for r in rows})))}</strong></div>
            </div>
          </div>
        </div>
      </div>
    </details>

    <section class='orders-panel panel'>
      <h2>Live Order Scope</h2>
      <p class='muted'>Pending-purchase queue rows are sourced from <code>store.purchase.order.list</code> per site with <code>orderStatusId: 2</code>, <code>fromDate: {g.ORDER_LIST_FROM_DATE}</code>, <code>toDate: {g.ORDER_LIST_TO_DATE}</code>.</p>
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
          {orders_table}
        </tbody>
      </table>
    </section>

    <section class='packet-groups'>
      {grouped_html}
    </section>
  </div>
  <script>
{tree_nav_runtime}
  </script>
  <script>
    // Initialize tree nav runtime (note: module exposes ReviewTreeNavControl).
    window.ReviewTreeNavControl.init({{
      navStorageKey: 'pending-purchases-2026-05-14:nav',
      sidebarStorageKey: 'pending-purchases-2026-05-14:sidebar',
      sidebarHiddenTarget: document.body,
      sidebarHiddenClassName: 'nav-hidden',
    }});
    document.addEventListener('keydown', function (event) {{
      if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey) {{
        // Don't toggle when typing in inputs.
        if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable)) {{
          return;
        }}
        document.body.classList.toggle('nav-hidden');
        try {{
          window.localStorage.setItem('pending-purchases-2026-05-14:sidebar',
            document.body.classList.contains('nav-hidden') ? 'hidden' : 'visible');
        }} catch (e) {{}}
        event.preventDefault();
      }}
    }});

    // Detail-row click-to-new-tab (carried from legacy template).
    document.querySelectorAll('.product-row').forEach(function (row) {{
      row.addEventListener('click', function (event) {{
        if (event.target.closest('a, input, label, button, select, textarea, code, .ladder-marker.proposed, .ladder-competitor')) return;
        if (window.getSelection && String(window.getSelection())) return;
        var href = row.dataset.detailHref;
        if (href) window.open(href, '_blank', 'noopener');
      }});
    }});

    // Draggable proposed-price marker on every price ladder. The marker sits
    // inside .pricing-ladder; we map the cursor X position back to the
    // domain-min/domain-max axis labels and update GM% live.
    function moneyText(value) {{
      if (value === null || value === undefined || isNaN(value)) return '-';
      return '$' + value.toFixed(2);
    }}
    function priceFromLeftPercent(leftPercent, domainMin, domainMax) {{
      var clamped = Math.max(0, Math.min(100, leftPercent));
      return domainMin + (domainMax - domainMin) * (clamped / 100);
    }}
    function updateProposedMarker(marker, newPrice) {{
      var ladder = marker.closest('.pricing-ladder');
      if (!ladder) return;
      var domainMin = parseFloat(ladder.dataset.domainMin);
      var domainMax = parseFloat(ladder.dataset.domainMax);
      if (!isFinite(domainMin) || !isFinite(domainMax)) return;
      var cost = parseFloat(ladder.dataset.cost);
      var POST_TAX = 1.13;
      var leftPercent = (newPrice - domainMin) / (domainMax - domainMin) * 100;
      leftPercent = Math.max(0, Math.min(100, leftPercent));
      marker.style.left = leftPercent.toFixed(2) + '%';
      var gmText = '';
      if (isFinite(cost) && cost > 0 && newPrice > 0) {{
        var gm = (1 - POST_TAX * cost / newPrice) * 100;
        gmText = gm.toFixed(2) + '% GM';
      }} else {{
        gmText = 'GM unavailable';
      }}
      // Update tooltip.
      marker.setAttribute('title',
        'Proposed price: ' + moneyText(newPrice) + '\\n' + 'Proposed GM: ' + gmText
      );
      // Update head metric (current -> proposed) for this ladder shell.
      var shell = ladder.closest('.pricing-ladder-shell');
      if (shell) {{
        var head = shell.querySelector('.pricing-ladder-head .metric');
        if (head) {{
          var currentText = (head.textContent || '').split('->')[0] || (head.textContent || '').split('-&gt;')[0];
          head.innerHTML = (currentText.trim() + ' -> ' + moneyText(newPrice) + ' <span class="metric-detail">(' + gmText + ')</span>');
        }}
      }}
    }}
    function snapToHalfDollar(value) {{
      // Allow free movement; reviewer can fine-tune. We snap at drop time.
      return Math.round(value * 2) / 2;
    }}

    // ---- Override tracking + submit/export ----
    var OVERRIDE_STORAGE_KEY = 'pending-purchases-2026-05-14:overrides';
    var overrides = (function () {{
      try {{ var raw = window.localStorage.getItem(OVERRIDE_STORAGE_KEY); return raw ? JSON.parse(raw) : {{}}; }} catch (e) {{ return {{}}; }}
    }})();
    function persistOverrides() {{
      try {{ window.localStorage.setItem(OVERRIDE_STORAGE_KEY, JSON.stringify(overrides)); }} catch (e) {{}}
      updateSubmitBadge();
    }}
    function dpIdForRow(row) {{
      if (!row) return null;
      var href = row.dataset && row.dataset.detailHref;
      if (!href) return null;
      var basename = href.split('/').pop() || '';
      return basename.replace(/\\.html$/, '') || null;
    }}
    function rowMetaForRow(row) {{
      if (!row) return {{}};
      var meta = row.querySelector('.meta-stack');
      var variantName = meta && meta.querySelector('strong') ? meta.querySelector('strong').textContent.trim() : '';
      var subline = meta ? meta.querySelectorAll('span.muted') : [];
      var brandLine = subline && subline[0] ? subline[0].textContent.trim() : '';
      return {{ variantName: variantName, brandLine: brandLine }};
    }}
    function recordOverride(marker, finalPrice) {{
      var row = marker.closest('.product-row');
      var dpId = dpIdForRow(row);
      if (!dpId) return;
      var ladder = marker.closest('.pricing-ladder');
      var initialPrice = parseFloat(ladder.dataset.initialProposed);
      if (Math.abs(finalPrice - initialPrice) < 0.01) {{
        delete overrides[dpId];
      }} else {{
        var meta = rowMetaForRow(row);
        var cost = parseFloat(ladder.dataset.cost);
        var POST_TAX = 1.13;
        var gm = (isFinite(cost) && cost > 0 && finalPrice > 0) ? (1 - POST_TAX * cost / finalPrice) * 100 : null;
        overrides[dpId] = {{
          distributorProductId: dpId,
          initialProposedPrice: initialPrice,
          overriddenProposedPrice: finalPrice,
          cost: isFinite(cost) ? cost : null,
          overriddenGmPercent: gm !== null ? Math.round(gm * 100) / 100 : null,
          variantName: meta.variantName,
          rowSummary: meta.brandLine,
          editedAt: new Date().toISOString(),
        }};
      }}
      persistOverrides();
    }}
    function restoreOverrides() {{
      Object.keys(overrides).forEach(function (dpId) {{
        var rows = document.querySelectorAll('.product-row');
        for (var i = 0; i < rows.length; i += 1) {{
          if (dpIdForRow(rows[i]) === dpId) {{
            var marker = rows[i].querySelector('.pricing-ladder .ladder-marker.proposed');
            if (marker) updateProposedMarker(marker, overrides[dpId].overriddenProposedPrice);
            break;
          }}
        }}
      }});
      updateSubmitBadge();
    }}

    document.querySelectorAll('.pricing-ladder .ladder-marker.proposed').forEach(function (marker) {{
      var ladder = marker.closest('.pricing-ladder');
      var domainMin = parseFloat(ladder.dataset.domainMin);
      var domainMax = parseFloat(ladder.dataset.domainMax);
      var leftPct = parseFloat((marker.style.left || '0').replace('%', ''));
      var initialPrice = priceFromLeftPercent(leftPct, domainMin, domainMax);
      ladder.dataset.initialProposed = initialPrice.toFixed(4);

      var dragging = false;
      function onMove(event) {{
        if (!dragging || !ladder) return;
        var rect = ladder.getBoundingClientRect();
        var pct = ((event.clientX - rect.left) / rect.width) * 100;
        var dmin = parseFloat(ladder.dataset.domainMin);
        var dmax = parseFloat(ladder.dataset.domainMax);
        var price = priceFromLeftPercent(pct, dmin, dmax);
        updateProposedMarker(marker, price);
      }}
      function onUp(event) {{
        if (!dragging || !ladder) return;
        dragging = false;
        marker.classList.remove('is-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        var rect = ladder.getBoundingClientRect();
        var pct = ((event.clientX - rect.left) / rect.width) * 100;
        var dmin = parseFloat(ladder.dataset.domainMin);
        var dmax = parseFloat(ladder.dataset.domainMax);
        var price = snapToHalfDollar(priceFromLeftPercent(pct, dmin, dmax));
        updateProposedMarker(marker, price);
        recordOverride(marker, price);
      }}
      marker.addEventListener('mousedown', function (event) {{
        event.preventDefault();
        event.stopPropagation();
        dragging = true;
        marker.classList.add('is-dragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }});
    }});

    var submitBar = document.createElement('div');
    submitBar.className = 'submit-bar';
    submitBar.innerHTML = ''
      + '<div class="submit-bar-inner">'
      + '  <span class="submit-bar-summary">No changes yet</span>'
      + '  <button type="button" class="submit-bar-btn submit-export">Save / Export overrides</button>'
      + '  <button type="button" class="submit-bar-btn submit-clear">Reset</button>'
      + '</div>';
    document.body.appendChild(submitBar);
    function updateSubmitBadge() {{
      var count = Object.keys(overrides).length;
      var summary = submitBar.querySelector('.submit-bar-summary');
      var exportBtn = submitBar.querySelector('.submit-export');
      if (count === 0) {{
        summary.textContent = 'No changes yet';
        exportBtn.disabled = true;
        submitBar.classList.remove('has-changes');
      }} else {{
        summary.textContent = count + ' price override' + (count === 1 ? '' : 's') + ' staged';
        exportBtn.disabled = false;
        submitBar.classList.add('has-changes');
      }}
    }}
    submitBar.querySelector('.submit-export').addEventListener('click', function () {{
      var payload = {{
        packetTitle: document.title,
        generatedAt: new Date().toISOString(),
        overrides: Object.keys(overrides).sort().map(function (k) {{ return overrides[k]; }}),
      }};
      var blob = new Blob([JSON.stringify(payload, null, 2) + '\\n'], {{ type: 'application/json' }});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'pending-purchases-2026-05-14_price_overrides_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }});
    submitBar.querySelector('.submit-clear').addEventListener('click', function () {{
      if (!confirm('Reset all staged price overrides? This will revert every dragged proposed marker.')) return;
      Object.keys(overrides).forEach(function (k) {{ delete overrides[k]; }});
      persistOverrides();
      document.querySelectorAll('.pricing-ladder').forEach(function (ladder) {{
        var marker = ladder.querySelector('.ladder-marker.proposed');
        if (!marker) return;
        var initialPrice = parseFloat(ladder.dataset.initialProposed);
        if (isFinite(initialPrice)) updateProposedMarker(marker, initialPrice);
      }});
    }});
    restoreOverrides();
  </script>
</body>
</html>
"""


# --------------------------------------------------------------------------------------
# Post-process: enrich the legacy ladder DOM so the JS knows domainMin/Max/cost
# without re-parsing them out of the rendered text.
# --------------------------------------------------------------------------------------

import re as _re

_LADDER_OPEN = _re.compile(r'(<div class="pricing-ladder(?: is-detail)?")>')


def _stamp_ladder_dataset(html_text: str, rows_by_dp: dict) -> str:
    """Replace each <div class="pricing-ladder"> with a tagged version that
    carries data-domain-min/data-domain-max/data-cost for the JS dragger.

    The legacy renderer doesn't include data attributes; the simplest way to
    add them without rewriting render_pricing_ladder is to do a regex pass
    that walks each ladder occurrence in document order and assigns from the
    rows in the document order they appear (sorted within each brand block by
    target variant name then DP name, which matches what render_brand_table
    produces).
    """
    return html_text  # no-op stub; we use a richer in-place renderer below.


# Instead of a regex replacement we monkey-patch render_pricing_ladder to
# emit the data attributes inline. This is the cleanest hookpoint.

_original_render_pricing_ladder = g.render_pricing_ladder


def _patched_render_pricing_ladder(row: dict, detail: bool = False) -> str:
    rendered = _original_render_pricing_ladder(row, detail=detail)
    domain_min = row.get("pricingDomainMin")
    domain_max = row.get("pricingDomainMax")
    cost = row.get("effectiveUnitCost")
    if domain_min is None or domain_max is None:
        return rendered
    data_attrs = (
        f' data-domain-min="{float(domain_min):.4f}"'
        f' data-domain-max="{float(domain_max):.4f}"'
        f' data-cost="{float(cost) if cost is not None else 0.0:.4f}"'
    )
    return rendered.replace(
        '<div class="pricing-ladder">', f'<div class="pricing-ladder"{data_attrs}>', 1
    ).replace(
        '<div class="pricing-ladder is-detail">',
        f'<div class="pricing-ladder is-detail"{data_attrs}>', 1,
    )


g.render_pricing_ladder = _patched_render_pricing_ladder


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------

def main() -> int:
    all_rows: list[dict] = []
    all_orders: list[dict] = []
    for site in SITES:
        orders, groups = collect_for_site(site)
        # Stamp site context on orders for reviewer table.
        for o in orders:
            o["site"] = site["siteLabel"]
        all_orders.extend(orders)
        # Catalog inspection runs from the state dealer.
        g.switch_context(g.STATE_DEALER_ID, g.STATE_DEALER_NAME)
        all_rows.extend(build_rows_for_site(site, groups))

    write_detail_pages(all_rows)

    payload = {
        "packetTitle": PACKET_TITLE,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sites": SITES,
        "orders": all_orders,
        "rows": all_rows,
        "brandGmTargetOverrides": patches.BRAND_GM_TARGET_OVERRIDES,
    }
    OUTPUT_JSON.write_text(json.dumps(payload, indent=2, default=str) + "\n")
    OUTPUT_HTML.write_text(render_html(all_rows, all_orders))
    print(f"Wrote {OUTPUT_JSON}")
    print(f"Wrote {OUTPUT_HTML}")
    print(f"Wrote {len(all_rows)} detail page(s) to {OUTPUT_DETAIL_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
