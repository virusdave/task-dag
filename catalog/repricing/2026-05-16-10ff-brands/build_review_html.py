#!/usr/bin/env python3
"""Render the 67.7%-GM repricing dry-run proposal as a single self-
contained HTML review page. Output goes to `review.html` in this
directory and is meant to be uploaded via mss-one-offs."""
from __future__ import annotations

import html
import json
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
PROPOSAL_PATH = WORKDIR / "reprice_proposal_dryrun.json"
SUMMARY_PATH = WORKDIR / "reprice_summary_dryrun.json"
OUT_PATH = WORKDIR / "review.html"


def fmt_money(value) -> str:
    if value is None:
        return "—"
    try:
        return f"${float(value):.2f}"
    except (TypeError, ValueError):
        return str(value)


def fmt_pct(value) -> str:
    if value is None:
        return "—"
    try:
        return f"{float(value):.2f}%"
    except (TypeError, ValueError):
        return str(value)


def fmt_delta(current, proposed) -> str:
    if current is None or proposed is None:
        return "—"
    delta = float(proposed) - float(current)
    sign = "+" if delta > 0 else ""
    return f"{sign}{delta:.2f}"


def main() -> None:
    proposal = json.loads(PROPOSAL_PATH.read_text())
    summary = json.loads(SUMMARY_PATH.read_text())

    counts = summary["counts"]
    by_brand = summary["byBrand"]

    # Compute totals
    total_current = 0.0
    total_proposed = 0.0
    for group in proposal["groups"]:
        for product in group["products"]:
            if product["action"] == "edit":
                cur = product.get("currentPrice")
                prop = product.get("proposedPrice")
                if cur is not None and prop is not None:
                    total_current += float(cur)
                    total_proposed += float(prop)

    # Big-swing thresholds (for highlight pill)
    BIG_DELTA = 5.00

    parts: list[str] = []
    parts.append(f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>67.7% GM Reprice Review — 2026-05-15 10FF brands</title>
<style>
  :root {{
    --bg:#f4efe4; --card:#fffaf0; --ink:#1f1b17; --muted:#6d665b;
    --line:#d9ceb7; --edit:#27417e; --keep:#1f5d42; --skip:#8d2f52;
    --warn:#8b5e11; --up:#1f5d42; --down:#8d2f52;
  }}
  *{{box-sizing:border-box}}
  body{{margin:0;padding:24px;font:14px/1.5 -apple-system,system-ui,sans-serif;
        background:var(--bg);color:var(--ink)}}
  .wrap{{max-width:1400px;margin:0 auto}}
  h1{{margin:0 0 6px}}
  .sub{{color:var(--muted);margin:0 0 18px}}
  .card{{background:var(--card);border:1px solid var(--line);
         border-radius:14px;padding:18px;margin:14px 0;
         box-shadow:0 4px 16px rgba(31,27,23,0.05)}}
  table{{border-collapse:collapse;width:100%}}
  th,td{{padding:6px 8px;text-align:left;border-bottom:1px solid var(--line);
        vertical-align:top}}
  th{{background:#efe3cf;font-weight:600;font-size:12px;text-transform:uppercase;
      letter-spacing:0.04em;color:var(--muted)}}
  .num{{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}}
  .pill{{display:inline-block;padding:1px 8px;border-radius:999px;
        font-size:11px;font-weight:600;text-transform:uppercase;
        letter-spacing:0.04em}}
  .pill.edit{{background:#e2eaf5;color:var(--edit)}}
  .pill.keep{{background:#dfeae2;color:var(--keep)}}
  .pill.skip{{background:#f3dde4;color:var(--skip)}}
  .pill.up{{background:#dfeae2;color:var(--up)}}
  .pill.down{{background:#f3dde4;color:var(--down)}}
  .pill.big{{background:#f0e1c2;color:var(--warn)}}
  .delta-up{{color:var(--up);font-weight:600}}
  .delta-down{{color:var(--down);font-weight:600}}
  .delta-zero{{color:var(--muted)}}
  .keep-row td{{opacity:0.55}}
  .brand-h{{margin:24px 0 8px;font-size:18px}}
  .stats{{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
          gap:10px;margin-top:10px}}
  .stat{{padding:10px 12px;background:#fff;border:1px solid var(--line);
        border-radius:10px}}
  .stat .v{{font-size:22px;font-weight:600}}
  .stat .l{{font-size:11px;color:var(--muted);text-transform:uppercase;
           letter-spacing:0.04em;margin-bottom:4px}}
  .note{{background:#fffaee;border:1px solid #f0e1c2;border-radius:10px;
        padding:12px 14px;color:#5d4214;margin:10px 0}}
  details > summary{{cursor:pointer;font-weight:600;padding:4px 0}}
  .cost-meta{{font-size:11px;color:var(--muted)}}
  code{{font-family:'SFMono-Regular',Menlo,monospace;font-size:12px}}
</style>
</head>
<body>
<div class="wrap">
  <h1>67.7% GM Reprice Review</h1>
  <p class="sub">Brands from the 2026-05-15 midtown 10FF manifest ·
    State dealer {proposal['stateDealerId']} ({html.escape(proposal['stateDealerName'])}) ·
    Generated {html.escape(proposal['generatedAt'])} (dry-run)</p>

  <div class="card">
    <strong>What this is.</strong> A proposal to rewrite the per-variant
    catalog <code>price</code> on every active variant for the nine brands
    that appeared on the 2026-05-15 midtown 10FF order, targeting a
    <strong>67.7% gross margin</strong> on the most-recent distributor
    cost (rounded to nearest $0.25 with a mild pull toward .00 and .50
    endings — max push ±$0.15).
    <br><br>
    The 67.7% target is intentionally above the canonical Helios 55–65%
    non-MSO band; the spread is absorbed by active promos per vendor
    agreement. This proposal does <em>not</em> touch promos, per-site
    overrides, or any non-price fields.
    <br><br>
    Formula: <code>price = 1.13 × cost / (1 − 0.677)</code> ≈ <code>3.4985 × cost</code>.
    Cost source: most recent <code>pricesLists</code> entry across every
    linked <code>store.distributor.product</code> row at the state dealer.
  </div>

  <div class="stats">
    <div class="stat"><div class="l">Products in scope</div>
        <div class="v">{sum(counts.values())}</div></div>
    <div class="stat"><div class="l">Edits queued</div>
        <div class="v" style="color:var(--edit)">{counts.get('edit',0)}</div></div>
    <div class="stat"><div class="l">Already correct</div>
        <div class="v" style="color:var(--keep)">{counts.get('keep',0)}</div></div>
    <div class="stat"><div class="l">Skipped (no cost)</div>
        <div class="v" style="color:var(--skip)">{counts.get('skip',0)}</div></div>
    <div class="stat"><div class="l">∑ current price (edits)</div>
        <div class="v">${total_current:,.2f}</div></div>
    <div class="stat"><div class="l">∑ proposed price (edits)</div>
        <div class="v">${total_proposed:,.2f}</div></div>
    <div class="stat"><div class="l">Net change (edits)</div>
        <div class="v" style="color:{'var(--up)' if total_proposed>=total_current else 'var(--down)'}">
            {'+' if total_proposed>=total_current else ''}${total_proposed-total_current:,.2f}</div></div>
  </div>

  <div class="card">
    <strong>By brand</strong>
    <table style="margin-top:8px">
      <thead><tr><th>Brand</th><th class="num">Edit</th>
        <th class="num">Keep</th><th class="num">Skip</th>
        <th class="num">Total</th></tr></thead>
      <tbody>
""")
    for brand in sorted(by_brand.keys()):
        per = by_brand[brand]
        total = per.get("edit", 0) + per.get("keep", 0) + per.get("skip", 0)
        parts.append(
            f'<tr><td>{html.escape(brand)}</td>'
            f'<td class="num">{per.get("edit",0)}</td>'
            f'<td class="num">{per.get("keep",0)}</td>'
            f'<td class="num">{per.get("skip",0)}</td>'
            f'<td class="num"><strong>{total}</strong></td></tr>'
        )
    parts.append("</tbody></table></div>")

    # Group blocks by brand
    by_brand_groups: dict[str, list[dict]] = {}
    for group in proposal["groups"]:
        by_brand_groups.setdefault(group["brandName"], []).append(group)

    for brand in sorted(by_brand_groups.keys()):
        parts.append(f'<h2 class="brand-h">{html.escape(brand)}</h2>')
        for group in by_brand_groups[brand]:
            n_edit = sum(1 for p in group["products"] if p["action"] == "edit")
            n_keep = sum(1 for p in group["products"] if p["action"] == "keep")
            n_skip = sum(1 for p in group["products"] if p["action"] == "skip")
            cat = html.escape(str(group.get("category") or ""))
            subcat = html.escape(str(group.get("subcategory") or ""))
            cat_label = f"{cat} / {subcat}" if subcat else cat
            parts.append(f"""
<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;
              flex-wrap:wrap;gap:8px">
    <div>
      <strong>{html.escape(str(group.get('fullName') or group.get('groupName') or ''))}</strong>
      <span class="cost-meta"> · group {group['groupId']} · {cat_label}</span>
    </div>
    <div>
      <span class="pill edit">edit {n_edit}</span>
      <span class="pill keep">keep {n_keep}</span>
      {f'<span class="pill skip">skip {n_skip}</span>' if n_skip else ''}
    </div>
  </div>
  <table style="margin-top:10px">
    <thead><tr>
      <th>Variant</th><th>Tab</th>
      <th class="num">Cost</th>
      <th class="num">Current $</th>
      <th class="num">Proposed $</th>
      <th class="num">Δ</th>
      <th class="num">Current GM</th>
      <th class="num">Proposed GM</th>
      <th>Action</th>
    </tr></thead>
    <tbody>
""")
            for product in group["products"]:
                action = product["action"]
                row_cls = "keep-row" if action == "keep" else ""
                current = product.get("currentPrice")
                proposed = product.get("proposedPrice")
                delta_class = "delta-zero"
                delta_text = "—"
                if action == "edit" and current is not None and proposed is not None:
                    d = float(proposed) - float(current)
                    if abs(d) < 0.005:
                        delta_class = "delta-zero"
                        delta_text = "0.00"
                    elif d > 0:
                        delta_class = "delta-up"
                        delta_text = f"+{d:.2f}"
                    else:
                        delta_class = "delta-down"
                        delta_text = f"{d:.2f}"

                big_pill = ""
                if action == "edit" and current is not None and proposed is not None:
                    if abs(float(proposed) - float(current)) >= BIG_DELTA:
                        big_pill = ' <span class="pill big">big swing</span>'

                cost_meta = ""
                src = product.get("costSource")
                if src:
                    cost_meta = (
                        f'<div class="cost-meta">{html.escape(str(src.get("distributorName") or ""))} · '
                        f'{html.escape(str(src.get("distributorProductName") or ""))} · '
                        f'from {html.escape(str(src.get("fromDate") or "—"))}</div>'
                    )
                skip_meta = ""
                if action == "skip":
                    skip_meta = f'<div class="cost-meta">{html.escape(str(product.get("skipReason") or ""))}</div>'

                parts.append(
                    f'<tr class="{row_cls}">'
                    f'<td>{html.escape(str(product.get("name") or ""))}<br>'
                    f'<span class="cost-meta">prod {product["productId"]}</span></td>'
                    f'<td>{html.escape(str(product.get("tab") or ""))}</td>'
                    f'<td class="num">{fmt_money(product.get("wholesaleCost"))}{cost_meta}</td>'
                    f'<td class="num">{fmt_money(current)}</td>'
                    f'<td class="num"><strong>{fmt_money(proposed)}</strong></td>'
                    f'<td class="num {delta_class}">{delta_text}</td>'
                    f'<td class="num">{fmt_pct(product.get("currentGmPercent"))}</td>'
                    f'<td class="num">{fmt_pct(product.get("proposedGmPercent"))}</td>'
                    f'<td><span class="pill {action}">{action}</span>{big_pill}{skip_meta}</td>'
                    f'</tr>'
                )
            parts.append("</tbody></table></div>")

    parts.append("</div></body></html>")
    OUT_PATH.write_text("".join(parts))
    print(f"Wrote {OUT_PATH} ({OUT_PATH.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
