#!/usr/bin/env python3
"""Build the gads experiments visualizer as a single self-contained HTML file.

Reads:
  - L2 outputs at ads/google/outputs/*/json/run-*-l2-output.json (trials)
  - Latest snapshot at ads/google/snapshots/ads-snapshot-live.jsonl (live status)
  - CSVs at ads/google/outputs/*/csv/*.csv (to bundle)

Writes:
  - One HTML file (default: ads/google/outputs/experiments-viz.html) that
    embeds CSS, JSON data, and a base64 ZIP of all CSVs as a data: URL so
    the "Download CSV bundle" button works through the oauth proxy with no
    extra round-trips.

Designed per ads/google/docs/EXPERIMENTS_VIZ_UI_SPEC.md (mobile-first).
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import glob
import html
import io
import json
import os
import re
import sys
import zipfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
GADS_ROOT = REPO_ROOT / "ads" / "google"


def load_l2_runs() -> list[dict]:
    runs = []
    for path in sorted(glob.glob(str(GADS_ROOT / "outputs" / "*" / "json" / "run-*-l2-output.json"))):
        try:
            with open(path) as f:
                data = json.load(f)
            data["_source_file"] = os.path.relpath(path, REPO_ROOT)
            data["_source_bucket"] = Path(path).parts[-3]
            runs.append(data)
        except Exception as e:
            print(f"  skipped {path}: {e}", file=sys.stderr)
    return runs


def load_latest_snapshot() -> list[dict]:
    live = GADS_ROOT / "snapshots" / "ads-snapshot-live.jsonl"
    if not live.exists():
        return []
    rows = []
    with open(live) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def build_csv_zip() -> bytes:
    """Bundle every CSV under outputs/*/csv into a single ZIP, sequentially numbered."""
    csv_paths = sorted(glob.glob(str(GADS_ROOT / "outputs" / "*" / "csv" / "*.csv")))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # Group by source bucket to keep provenance visible
        seq = 1
        for path in csv_paths:
            bucket = Path(path).parts[-3]
            original = Path(path).name
            # Strip leading NNN- from filename so we can renumber globally
            stripped = re.sub(r"^\d+-", "", original)
            entry = f"{seq:03d}-{bucket}-{stripped}"
            with open(path, "rb") as f:
                zf.writestr(entry, f.read())
            seq += 1
        # Add a manifest
        manifest = {
            "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
            "file_count": seq - 1,
            "source_repo": "FreshlyBakedNYC/automation",
            "note": "Import files in numeric order via Google Ads Editor.",
        }
        zf.writestr("MANIFEST.json", json.dumps(manifest, indent=2))
    return buf.getvalue()


# ---- Data transformation ----------------------------------------------------

TRIAL_NAME_RE = re.compile(r"-trial-\d+", re.IGNORECASE)


def flatten_trials(l2_runs: list[dict]) -> list[dict]:
    """One row per planned/executed trial."""
    trials = []
    for run in l2_runs:
        for family in run.get("families", []):
            family_key = family.get("family_key", {})
            for trial in family.get("trial_plans", []):
                trials.append(
                    {
                        "run_id": run.get("run_id"),
                        "source_bucket": run.get("_source_bucket"),
                        "family_key": family_key,
                        "name": trial.get("trial_group_name") or "(unnamed)",
                        "hypothesis": trial.get("hypothesis") or "",
                        "policy_class": trial.get("policy_class")
                        or trial.get("policy_class_being_probed")
                        or "(unspecified)",
                        "budget": trial.get("budget")
                        or trial.get("trial_budget_usd")
                        or 0.01,
                        "controls": trial.get("controls") or trial.get("control_ads") or [],
                        "variants": trial.get("variants")
                        or trial.get("variant_creatives")
                        or trial.get("variant_ads")
                        or [],
                        "success_criteria": trial.get("success_criteria") or {},
                        "expected_insights": trial.get("expected_insights") or "",
                    }
                )
    return trials


def correlate_live_status(trials: list[dict], snapshot: list[dict]) -> dict[str, list[dict]]:
    """For each trial name, find snapshot rows whose ad_group_name contains the trial token."""
    by_trial: dict[str, list[dict]] = {}
    trial_tokens = [(t["name"], t["name"].lower()) for t in trials if t["name"]]
    for row in snapshot:
        ag = (row.get("ad_group_name") or row.get("ad_group_id") or "").lower()
        for name, token in trial_tokens:
            if token and token in ag:
                by_trial.setdefault(name, []).append(row)
                break
    return by_trial


def classify_trial(trial: dict, live_rows: list[dict]) -> str:
    """Return one of: planned, in_flight, completed."""
    if not live_rows:
        return "planned"
    # Any row served impressions => in_flight or completed depending on age
    impressions = sum(r.get("metrics", {}).get("impressions", 0) for r in live_rows)
    if impressions > 0:
        return "in_flight"
    return "in_flight"  # exists in snapshot but no traffic yet


def detect_persistent_positives(snapshot: list[dict]) -> list[dict]:
    """Trial-named ads that snapshot reports as approved + eligible + enabled."""
    out = []
    for row in snapshot:
        ag = (row.get("ad_group_name") or row.get("ad_group_id") or "")
        if not TRIAL_NAME_RE.search(ag):
            continue
        if (
            row.get("policy_status") == "approved"
            and row.get("serving_status") == "eligible"
            and row.get("ad_status") == "enabled"
        ):
            out.append(
                {
                    "ad_group_name": ag,
                    "headline": (row.get("headlines") or [""])[0],
                    "policy_topics": row.get("policy_topics") or [],
                    "metrics": row.get("metrics") or {},
                    "snapshot_date": row.get("snapshot_date"),
                }
            )
    return out


# ---- HTML rendering ---------------------------------------------------------

PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1220">
<title>Gads Experiments — Issue #11</title>
<style>
:root {{
  --bg: #0b1220;
  --card: #131c2e;
  --card-2: #1a2540;
  --text: #e6ecf5;
  --muted: #9aa6b8;
  --accent: #60a5fa;
  --good: #34d399;
  --warn: #fbbf24;
  --bad: #f87171;
  --border: #2a3553;
}}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; padding: 0; background: var(--bg); color: var(--text);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto,
  "Helvetica Neue", Arial, sans-serif; -webkit-text-size-adjust: 100%; }}
a {{ color: var(--accent); }}
header.bar {{
  position: sticky; top: 0; z-index: 10;
  display: flex; gap: 12px; align-items: center; justify-content: space-between;
  padding: 12px 16px; background: rgba(11,18,32,0.92);
  backdrop-filter: saturate(140%) blur(8px);
  border-bottom: 1px solid var(--border);
}}
header.bar h1 {{ font-size: 1.05rem; margin: 0; font-weight: 600; }}
header.bar .meta {{ font-size: 0.75rem; color: var(--muted); }}
.btn {{
  display: inline-flex; align-items: center; gap: 8px;
  min-height: 44px; padding: 0 16px; border-radius: 999px;
  background: var(--accent); color: #0b1220; font-weight: 600;
  text-decoration: none; border: 0; cursor: pointer; font-size: 0.95rem;
  white-space: nowrap;
}}
.btn:active {{ transform: scale(0.97); }}
.btn.secondary {{ background: transparent; color: var(--text); border: 1px solid var(--border); }}
main {{ padding: 16px; max-width: 1100px; margin: 0 auto; }}
section {{ margin: 24px 0; }}
section > h2 {{ font-size: 1.15rem; margin: 0 0 12px; display: flex; align-items: baseline; gap: 8px; }}
section > h2 .count {{ color: var(--muted); font-weight: 400; font-size: 0.85rem; }}
.cards {{ display: grid; grid-template-columns: 1fr; gap: 12px; }}
@media (min-width: 768px) {{
  .cards {{ grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }}
}}
.stat {{
  padding: 16px; background: linear-gradient(135deg, var(--card-2), var(--card));
  border: 1px solid var(--border); border-radius: 14px;
}}
.stat .v {{ font-size: 2rem; font-weight: 700; line-height: 1.1; }}
.stat .v.good {{ color: var(--good); }}
.stat .v.warn {{ color: var(--warn); }}
.stat .v.bad {{ color: var(--bad); }}
.stat .l {{ font-size: 0.85rem; color: var(--muted); margin-top: 6px; }}
.card {{
  background: var(--card); border: 1px solid var(--border);
  border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 8px;
}}
.card .row {{ display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }}
.card .title {{ font-weight: 600; font-size: 1rem; }}
.card .sub {{ color: var(--muted); font-size: 0.85rem; }}
.tag {{
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  font-size: 0.72rem; font-weight: 600; letter-spacing: 0.02em;
  background: var(--card-2); color: var(--text); border: 1px solid var(--border);
}}
.tag.good {{ background: rgba(52,211,153,.12); color: var(--good); border-color: rgba(52,211,153,.4); }}
.tag.warn {{ background: rgba(251,191,36,.12); color: var(--warn); border-color: rgba(251,191,36,.4); }}
.tag.bad {{ background: rgba(248,113,113,.12); color: var(--bad); border-color: rgba(248,113,113,.4); }}
.tag.info {{ background: rgba(96,165,250,.12); color: var(--accent); border-color: rgba(96,165,250,.4); }}
.hyp {{ font-style: italic; color: #cdd6e3; border-left: 3px solid var(--accent); padding-left: 10px; }}
.kv {{ display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 0.85rem; color: var(--muted); }}
.kv b {{ color: var(--text); font-weight: 500; }}
details > summary {{ cursor: pointer; padding: 6px 0; color: var(--accent); font-weight: 600; list-style: none; }}
details > summary::-webkit-details-marker {{ display: none; }}
details > summary:before {{ content: "▸ "; }}
details[open] > summary:before {{ content: "▾ "; }}
ul.snippets {{ list-style: none; padding: 0; margin: 4px 0 0; font-size: 0.85rem; }}
ul.snippets li {{ padding: 4px 8px; background: var(--card-2); border-radius: 6px; margin-top: 4px; }}
footer {{ margin: 32px 0 16px; padding: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.8rem; }}
footer .row {{ display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; }}
.empty {{ padding: 20px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 14px; }}
</style>
</head>
<body>
<header class="bar">
  <h1>🧪 Gads Experiments</h1>
  <a class="btn" download="gads-experiments-bundle.zip" href="data:application/zip;base64,{csv_b64}">⬇ CSV bundle</a>
</header>
<main>
  <div class="meta" style="color:var(--muted);font-size:0.8rem;margin-bottom:8px;">
    Generated {generated_at} · {trial_count} trial(s) · {csv_count} CSV(s) in bundle · Issue
    <a href="https://github.com/FreshlyBakedNYC/automation/issues/11">#11</a>
  </div>

  <section>
    <h2>Summary</h2>
    <div class="cards">
      <div class="stat"><div class="v">{total_trials}</div><div class="l">Total trials</div></div>
      <div class="stat"><div class="v">{total_variants}</div><div class="l">Variant ads</div></div>
      <div class="stat"><div class="v good">{persistent_count}</div><div class="l">Persistent positive approvals</div></div>
      <div class="stat"><div class="v">${total_budget:.2f}</div><div class="l">Daily trial budget</div></div>
    </div>
  </section>

  <section>
    <h2>🟢 Persistent positive approvals <span class="count">({persistent_count})</span></h2>
    {persistent_html}
  </section>

  <section>
    <h2>🔥 In flight <span class="count">({in_flight_count})</span></h2>
    {in_flight_html}
  </section>

  <section>
    <h2>📋 Planned (not yet pushed to gads) <span class="count">({planned_count})</span></h2>
    {planned_html}
  </section>

  <section>
    <h2>📚 Lessons & completed <span class="count">({completed_count})</span></h2>
    {completed_html}
  </section>

  <footer>
    <div class="row">
      <div>Source: {source_runs} L2 run(s) · snapshot {snapshot_date} · {snapshot_count} ad row(s)</div>
      <a class="btn secondary" download="gads-experiments-bundle.zip" href="data:application/zip;base64,{csv_b64}">⬇ Download CSV bundle</a>
    </div>
  </footer>
</main>
</body>
</html>
"""


def _esc(x: Any) -> str:
    return html.escape(str(x), quote=True)


def render_family(fk: dict) -> str:
    parts = []
    if fk.get("creative_theme"):
        parts.append(fk["creative_theme"])
    if fk.get("product_tag"):
        parts.append(fk["product_tag"])
    if fk.get("geo_target"):
        parts.append(fk["geo_target"])
    if fk.get("campaign_name"):
        parts.append(fk["campaign_name"])
    return " / ".join(parts) or "Unknown family"


def render_trial_card(t: dict, live_rows: list[dict], status_tag_class: str, status_label: str) -> str:
    controls = t["controls"] if isinstance(t["controls"], list) else []
    variants = t["variants"] if isinstance(t["variants"], list) else []

    def ad_text(a: Any) -> str:
        if isinstance(a, str):
            return a
        if isinstance(a, dict):
            cr = a.get("creative") or a
            heads = cr.get("headlines") or []
            descs = cr.get("descriptions") or []
            return f"{heads[0] if heads else ''} | {descs[0] if descs else ''}"
        return str(a)

    snippets = []
    for c in controls[:2]:
        snippets.append(f'<li><b style="color:var(--good)">CTRL</b> {_esc(ad_text(c))}</li>')
    for v in variants[:3]:
        snippets.append(f'<li><b style="color:var(--warn)">VAR</b> {_esc(ad_text(v))}</li>')

    impressions = sum(r.get("metrics", {}).get("impressions", 0) for r in live_rows)
    clicks = sum(r.get("metrics", {}).get("clicks", 0) for r in live_rows)
    ctr_pct = (clicks / impressions * 100) if impressions else 0

    return f"""
    <div class="card">
      <div class="row">
        <div class="title">{_esc(t["name"])}</div>
        <span class="tag {status_tag_class}">{_esc(status_label)}</span>
        <span class="tag info">{_esc(t["policy_class"])}</span>
      </div>
      <div class="sub">{_esc(render_family(t["family_key"]))} · ${_esc(f"{t['budget']:.2f}")}/day</div>
      <div class="hyp">{_esc(t["hypothesis"]) or "—"}</div>
      <div class="kv">
        <span>Controls</span><b>{len(controls)}</b>
        <span>Variants</span><b>{len(variants)}</b>
        <span>Live ad rows</span><b>{len(live_rows)}</b>
        <span>Impressions</span><b>{impressions:,}</b>
        <span>CTR</span><b>{ctr_pct:.2f}%</b>
      </div>
      <details>
        <summary>Sample ads</summary>
        <ul class="snippets">{''.join(snippets) or '<li>No ads recorded</li>'}</ul>
      </details>
      {f'<div class="sub">💡 {_esc(t["expected_insights"])}</div>' if t.get("expected_insights") else ''}
    </div>
    """


def render_persistent(rows: list[dict]) -> str:
    if not rows:
        return '<div class="empty">No persistent positive approvals detected yet. Once trial-named ads survive policy review enabled+eligible+approved for ≥1 day, they appear here.</div>'
    cards = []
    for r in rows[:50]:
        cards.append(
            f"""
        <div class="card">
          <div class="row">
            <div class="title">{_esc(r["ad_group_name"])}</div>
            <span class="tag good">approved</span>
            <span class="tag good">eligible</span>
            <span class="tag good">enabled</span>
          </div>
          <div class="sub">First headline: {_esc(r["headline"])}</div>
          <div class="kv">
            <span>Snapshot</span><b>{_esc(r.get("snapshot_date") or "—")}</b>
            <span>Impressions</span><b>{int(r["metrics"].get("impressions", 0)):,}</b>
            <span>Clicks</span><b>{int(r["metrics"].get("clicks", 0)):,}</b>
          </div>
        </div>"""
        )
    return f'<div class="cards">{"".join(cards)}</div>'


def build_html(out_path: Path) -> Path:
    print(f"  loading L2 runs from {GADS_ROOT}/outputs/*/json/...")
    l2_runs = load_l2_runs()
    print(f"  loaded {len(l2_runs)} L2 run(s)")
    print(f"  loading snapshot...")
    snapshot = load_latest_snapshot()
    snapshot_date = (snapshot[0].get("snapshot_date") if snapshot else None) or "(none)"
    print(f"  loaded {len(snapshot)} snapshot row(s) (date={snapshot_date})")
    print(f"  building CSV bundle ZIP...")
    csv_zip = build_csv_zip()
    csv_count = 0
    with zipfile.ZipFile(io.BytesIO(csv_zip)) as zf:
        csv_count = sum(1 for n in zf.namelist() if n.lower().endswith(".csv"))
    print(f"  ZIP contains {csv_count} CSV file(s), {len(csv_zip)} bytes")

    trials = flatten_trials(l2_runs)
    live_by_trial = correlate_live_status(trials, snapshot)
    persistent = detect_persistent_positives(snapshot)

    in_flight, planned, completed = [], [], []
    for t in trials:
        live = live_by_trial.get(t["name"], [])
        cls = classify_trial(t, live)
        if cls == "in_flight":
            in_flight.append((t, live))
        elif cls == "completed":
            completed.append((t, live))
        else:
            planned.append((t, live))

    def render_group(group, status_tag_class, status_label, empty_msg):
        if not group:
            return f'<div class="empty">{html.escape(empty_msg)}</div>'
        cards = [render_trial_card(t, live, status_tag_class, status_label) for t, live in group]
        return f'<div class="cards">{"".join(cards)}</div>'

    total_trials = len(trials)
    total_variants = sum(
        len(t["variants"]) if isinstance(t["variants"], list) else 0 for t in trials
    )
    total_budget = sum(float(t.get("budget") or 0) for t in trials)

    page = PAGE_TEMPLATE.format(
        csv_b64=base64.b64encode(csv_zip).decode("ascii"),
        generated_at=dt.datetime.now().strftime("%Y-%m-%d %H:%M %Z").strip(),
        trial_count=total_trials,
        csv_count=csv_count,
        total_trials=total_trials,
        total_variants=total_variants,
        persistent_count=len(persistent),
        total_budget=total_budget,
        persistent_html=render_persistent(persistent),
        in_flight_count=len(in_flight),
        in_flight_html=render_group(in_flight, "warn", "in flight",
                                    "No experiments in flight."),
        planned_count=len(planned),
        planned_html=render_group(planned, "info", "planned",
                                  "No planned experiments waiting for CSV import."),
        completed_count=len(completed),
        completed_html=render_group(completed, "good", "completed",
                                    "No completed experiments yet. As trials retire (T+48h), outcomes will appear here."),
        source_runs=len(l2_runs),
        snapshot_date=_esc(snapshot_date),
        snapshot_count=len(snapshot),
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(page, encoding="utf-8")
    return out_path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--output",
        default=str(GADS_ROOT / "outputs" / "experiments-viz.html"),
        help="Output HTML path",
    )
    args = ap.parse_args()
    out = build_html(Path(args.output))
    size = out.stat().st_size
    print(f"\n✅ Wrote {out} ({size:,} bytes)")


if __name__ == "__main__":
    main()
