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


TRIAL_SUFFIX_RE = re.compile(r"\s*[-]?\s*trial-\d+\s*$", re.IGNORECASE)


def _source_ad_group_name(trial_group_name: str) -> str:
    """Map 'NYC Bud-trial-001' -> 'NYC Bud'; keep base for matching."""
    return TRIAL_SUFFIX_RE.sub("", trial_group_name).strip()


def _ad_priority(row: dict) -> tuple:
    """Higher tuple = better candidate to clone for the trial."""
    return (
        bool(row.get("final_url")),
        row.get("policy_status") == "approved",
        row.get("serving_status") == "eligible",
        row.get("ad_status") == "enabled",
        len(row.get("headlines") or []),
        len(row.get("descriptions") or []),
    )


def resolve_source_ad(trial: dict, snapshot: list[dict]) -> dict | None:
    """Pick the best snapshot ad to base a trial's content on."""
    base = _source_ad_group_name(trial["name"]).lower()
    if not base:
        return None
    candidates = []
    for row in snapshot:
        ag = (row.get("ad_group_name") or row.get("ad_group_id") or "").lower()
        # Match if the snapshot ad group starts with the trial base
        # (e.g. 'NYC Bud | Core' starts with 'NYC Bud')
        if ag == base or ag.startswith(base + " ") or ag.startswith(base + " |") or ag.startswith(base + "-"):
            if row.get("ad_type") == "responsive_search_ad" and row.get("headlines"):
                candidates.append(row)
    if not candidates:
        return None
    return max(candidates, key=_ad_priority)


# Generic fallback URL used when the cloned source ad has no final_url
# (typical for disapproved ads). README directs the human to replace this
# per ad group before posting.
FALLBACK_FINAL_URL = "https://freshlybaked.us/"


def _clean_variant_label(label: str) -> str:
    """Strip internal ad-id suffixes like ' | Core-1' from L2-proposed
    variant labels so they read as actual ad headlines, not row identifiers."""
    # drop trailing '| <anything>-<digits>'
    out = re.sub(r"\s*\|\s*\w+-\d+\s*$", "", label)
    # drop trailing '-<digits>' if anything left
    out = re.sub(r"\s*-\s*\d+\s*$", "", out)
    return out.strip() or label.strip()


# ---- Google Ads Editor CSV generators --------------------------------------

# Google Ads Editor headline cap = 15, descriptions cap = 4.
HEADLINE_MAX = 15
DESCRIPTION_MAX = 4


def _csv(rows: list[dict], columns: list[str]) -> str:
    """Render rows -> CSV string with the given column order."""
    import csv as _csvmod
    buf = io.StringIO()
    w = _csvmod.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        # Stringify all values; blank for missing
        w.writerow({c: ("" if r.get(c) is None else str(r[c])) for c in columns})
    return buf.getvalue()


def _variant_headlines(source: list[str], variant_label: str) -> list[str]:
    """Mechanically derive variant headlines by swapping in the variant label
    for the first 1-2 headlines. Keeps the rest of the source ad's content so
    the ad remains coherent and Ads Editor accepts the row."""
    out = list(source)
    if not out:
        return [variant_label[:30]]
    out[0] = variant_label[:30]
    if len(out) >= 2 and len(variant_label) > 10:
        out[1] = (variant_label + " · Order Today")[:30]
    return out


def _dedupe_headlines(headlines: list[str]) -> list[str]:
    """RSAs reject duplicate headlines (Ads Editor: 'This headline is the
    same as another'). Comparison is case-insensitive after collapsing
    whitespace. We try to nudge later duplicates so they differ from
    earlier ones via cheap edits the user said work in practice:
      1. replace ' - ' with ', '
      2. swap trailing punctuation
      3. append a soft separator (' ·')
      4. as a last resort drop the duplicate (RSAs need 3-15 headlines)
    Always keep the first occurrence; only modify duplicates."""
    def norm(s: str) -> str:
        return re.sub(r"\s+", " ", s).strip().lower()

    seen: set[str] = set()
    out: list[str] = []
    for h in headlines:
        candidate = h
        n = norm(candidate)
        if n not in seen:
            seen.add(n)
            out.append(candidate)
            continue
        # Try mechanical edits in order.
        edits = [
            candidate.replace(" - ", ", "),
            candidate.replace(" – ", ", "),
            candidate.rstrip(".!?") + ".",
            candidate.rstrip(".!?") + "!",
            candidate + " ·",
            candidate + " ",
        ]
        fixed = None
        for e in edits:
            e = e[:30].rstrip()  # respect Google's 30-char headline cap
            if norm(e) not in seen and e:
                fixed = e
                break
        if fixed is not None:
            seen.add(norm(fixed))
            out.append(fixed)
        # else: silently drop the duplicate; RSAs only need 3 headlines min
    return out


def build_importable_csvs(trials: list[dict], snapshot: list[dict]) -> tuple[dict[str, str], dict]:
    """Return (filename -> CSV-text) plus a stats dict describing what was built.

    NOTE on naming: campaign / ad-group / ad / keyword text in these CSVs
    gets uploaded to Google. Do NOT leak our internal strategy (policy
    probing, hypotheses, etc.) in any user-visible field. Internal context
    stays in the HTML page (oauth-proxied) and the bundle's README.md
    (never uploaded).
    """
    today = dt.date.today().isoformat()
    # Neutral, non-leaky campaign name. Matches the existing '*-trial-NNN'
    # ad-group convention without telegraphing intent to Google.
    campaign_name = f"Trials {today}"

    resolved_trials = []
    skipped_set: dict[str, str] = {}
    seen_trial_names: set[str] = set()
    for t in trials:
        if t["name"] in seen_trial_names:
            continue
        seen_trial_names.add(t["name"])
        src = resolve_source_ad(t, snapshot)
        if not src:
            skipped_set[t["name"]] = "no matching ad group in snapshot"
            continue
        resolved_trials.append((t, src))
    skipped: list[tuple[str, str]] = list(skipped_set.items())

    if not resolved_trials:
        return {}, {
            "campaign_count": 0,
            "ad_group_count": 0,
            "keyword_count": 0,
            "ad_count": 0,
            "resolved_trials": 0,
            "skipped": skipped,
        }

    total_budget = max(1.00, round(sum(float(t.get("budget") or 0.01) for t, _ in resolved_trials) + 0.50, 2))

    # All rows live in ONE combined CSV with mixed entity types. Ads Editor
    # distinguishes campaign vs ad-group vs keyword vs ad rows by which
    # cells are populated -- empty cells mean "no change for this column on
    # this row". Importing four separate files is what made Ads Editor say
    # "nothing to post" before: each later file referenced a campaign that
    # was only a pending proposal, not yet posted.
    #
    # Column names + values follow the Google Ads Editor docs exactly:
    #   https://support.google.com/google-ads/editor/answer/57747
    # Notably:
    #   - Networks must be one of {Search, Google Search, Search Partners,
    #     Display, Select}, semicolon-separated; "Google search" (lower
    #     case) is silently ignored.
    #   - Languages must be ISO codes like 'en', semicolon-separated.
    #   - Locations go on their OWN row (each Location ID = one row).
    #     United States = 2840.
    #   - Phrase-match keywords must be wrapped in "double quotes" and
    #     use `Criterion type = Phrase`. (Broad would be unquoted, Exact
    #     would be in [brackets].)

    headline_cols = [f"Headline {i + 1}" for i in range(HEADLINE_MAX)]
    description_cols = [f"Description {i + 1}" for i in range(DESCRIPTION_MAX)]

    columns = [
        "Campaign",
        "Campaign type",
        "Campaign status",
        "Budget",
        "Budget type",
        "Networks",
        "Languages",
        "Bid strategy type",
        "Start date",
        "Location ID",
        "Ad group",
        "Ad group status",
        "Max CPC",
        "Keyword",
        "Criterion type",
        "Status",
        "Ad type",
        "Final URL",
        "Path 1",
        "Path 2",
    ] + headline_cols + description_cols

    rows: list[dict] = []

    # --- Campaign row (one) ---
    rows.append(
        {
            "Campaign": campaign_name,
            "Campaign type": "Search",
            "Campaign status": "Enabled",
            "Budget": f"{total_budget:.2f}",
            "Budget type": "Daily",
            "Networks": "Search",  # includes both Google Search and Search Partners
            "Languages": "en",
            "Bid strategy type": "Manual CPC",
            "Start date": today,
        }
    )

    # --- Location targeting row (US = 2840) on its own row ---
    rows.append(
        {
            "Campaign": campaign_name,
            "Location ID": "2840",
        }
    )

    # Google Ads enforces "max 3 enabled responsive search ads per ad
    # group". To stay safely under that and to keep each probe clean
    # (one variant per group makes the policy verdict unambiguous), we
    # cap each generated ad group at 1 control + 1 variant = 2 RSAs,
    # spreading additional variants across sequentially numbered
    # '*-trial-NNN' ad groups. This matches the '*-trial-00N' naming
    # convention from the original gads epic.
    MAX_VARIANTS_PER_AD_GROUP = 1

    def _expand_trials(trial_list):
        """Yield (ad_group_name, source_ad, list_of_variants) tuples.
        For each L2 trial, emit one ad group per variant (or one ad
        group with no variants if there are none), each named with a
        fresh sequential -trial-NNN suffix."""
        for t, src in trial_list:
            base = _source_ad_group_name(t["name"])
            variants = t.get("variants") or []
            if not variants:
                yield (f"{base}-trial-001", src, [])
                continue
            # Chunk variants into groups of MAX_VARIANTS_PER_AD_GROUP
            chunks = [
                variants[i : i + MAX_VARIANTS_PER_AD_GROUP]
                for i in range(0, len(variants), MAX_VARIANTS_PER_AD_GROUP)
            ]
            for idx, chunk in enumerate(chunks, start=1):
                yield (f"{base}-trial-{idx:03d}", src, chunk)

    expanded = list(_expand_trials(resolved_trials))

    # --- Ad-group rows ---
    for ag_name, _src, _variants in expanded:
        rows.append(
            {
                "Campaign": campaign_name,
                "Ad group": ag_name,
                "Ad group status": "Enabled",
                "Max CPC": "1.00",
            }
        )

    # --- Keyword rows (phrase-match, wrapped in quotes) ---
    keyword_count = 0
    for ag_name, _src, _variants in expanded:
        base = _source_ad_group_name(ag_name)
        seeds = sorted({s for s in {base, base.split(" | ")[0], base.split(" - ")[0]} if s})
        for kw in seeds:
            rows.append(
                {
                    "Campaign": campaign_name,
                    "Ad group": ag_name,
                    "Keyword": f'"{kw}"',  # phrase-match formatting
                    "Criterion type": "Phrase",
                    "Status": "Enabled",
                    "Max CPC": "1.00",
                }
            )
            keyword_count += 1

    # --- Ad rows (RSA: 1 control + up-to-MAX_VARIANTS_PER_AD_GROUP per group) ---
    def _ad_row(ag_name, headlines, descriptions, final_url, paths):
        # Ads Editor rejects duplicate headlines or descriptions within an
        # RSA ("This headline is the same as another"); dedupe before
        # writing the row so the human doesn't have to fix it by hand.
        # No 'Label' column -- it would reveal CONTROL vs VARIANT structure.
        headlines = _dedupe_headlines(headlines)[:HEADLINE_MAX]
        descriptions = _dedupe_headlines(descriptions)[:DESCRIPTION_MAX]
        row = {
            "Campaign": campaign_name,
            "Ad group": ag_name,
            "Status": "Enabled",
            "Ad type": "Responsive search ad",
            "Final URL": final_url or "",
        }
        for i, h in enumerate(headlines):
            row[f"Headline {i + 1}"] = h
        for i, d in enumerate(descriptions):
            row[f"Description {i + 1}"] = d
        for i, p in enumerate((paths or [])[:2]):
            row[f"Path {i + 1}"] = p
        return row

    needs_url_fix_set: set[str] = set()  # base brand names with no source URL
    ad_count = 0
    for ag_name, src, variants_chunk in expanded:
        src_h = src.get("headlines") or []
        src_d = src.get("descriptions") or []
        src_url = src.get("final_url") or ""
        if not src_url:
            src_url = FALLBACK_FINAL_URL
            needs_url_fix_set.add(_source_ad_group_name(ag_name))
        src_paths = src.get("paths") or []
        # Control: clone source verbatim
        rows.append(_ad_row(ag_name, src_h, src_d, src_url, src_paths))
        ad_count += 1
        # Variant(s) for this chunked ad group
        for v in variants_chunk:
            if isinstance(v, str):
                label = v
            elif isinstance(v, dict):
                label = v.get("variant_label") or v.get("label") or v.get("name") or "variant"
            else:
                label = "variant"
            clean_label = _clean_variant_label(label)
            v_h = _variant_headlines(src_h, clean_label)
            rows.append(_ad_row(ag_name, v_h, src_d, src_url, src_paths))
            ad_count += 1
    needs_url_fix: list[str] = sorted(needs_url_fix_set)

    combined_csv = _csv(rows, columns)
    campaign_rows = [r for r in rows if r.get("Campaign type")]
    ad_group_rows = [r for r in rows if r.get("Ad group status")]
    keyword_rows = [r for r in rows if r.get("Criterion type")]

    readme = f"""# Trials -- import bundle ({today})

Generated by ads/google/scripts/build-experiments-viz.py.

This README and the MANIFEST are for our eyes only; the CSV contents
themselves are what get uploaded to Google. Internal-strategy language
(e.g. policy probing, hypotheses, "control vs variant") deliberately
does NOT appear in any campaign/ad-group/ad/keyword field.

## Import (Google Ads Editor)

In Ads Editor: **Account -> Import -> From file...** -> select
`001-import.csv`. Review the proposed changes (Editor will preview the
campaign, ad groups, keywords, ads, and location targeting). Click
"Keep proposed changes", then **Post** to push to Google.

The file is ONE CSV containing campaign / location-target / ad-group /
keyword / ad rows mixed together. Ads Editor distinguishes them by
which columns are populated. Importing them as separate files (as the
previous bundle did) leaves later imports referencing a campaign that
is still only a pending proposal, which is why nothing posted.

Counts:

- {len(campaign_rows)} campaign
- 1 location target (US, Location ID 2840)
- {len(ad_group_rows)} ad group(s)
- {keyword_count} keyword(s) (phrase-match)
- {ad_count} RSA(s) (all Enabled)

## What this does

Creates a new "{campaign_name}" Search campaign at ${total_budget:.2f}/day,
populated with one Enabled ad group per planned trial. Each ad group
contains one or more Enabled RSAs: the first row cloned verbatim from
the best existing ad in the corresponding source ad group, followed by
one row per L2-proposed variant (first 1-2 headlines swapped to the
variant phrase).

Everything is Enabled so that Google's review pipeline picks up the new
ads shortly after "Post" in Ads Editor.

## Review before posting

Defaults are conservative; you should usually narrow them in Editor
before clicking Post:

- Location target: currently United States (ID 2840). Narrow to NY or
  your delivery zones in the campaign's Locations panel.
- Languages: 'en'.
- Networks: 'Search' (Google Search + Search Partners).
- Bid strategy: Manual CPC at $1.00. Switch to your usual strategy if
  you want this to actually compete in auction rather than only sit at
  the bid floor.
- Final URL: copied from the source ad when available. When the source
  ad had an empty final_url (typical for disapproved ads) we fall back
  to {FALLBACK_FINAL_URL} so the rows validate. You almost certainly
  want to replace those URLs with the real landing page before posting.

## Trials whose source ad had no Final URL (placeholder applied)

{chr(10).join(f"- {name}" for name in needs_url_fix) or "(none)"}

## Skipped trials (no matching source ad group in snapshot)

{chr(10).join(f"- {name}: {reason}" for name, reason in skipped) or "(none -- all trials resolved to a source ad)"}
"""

    files = {
        "001-import.csv": combined_csv,
        "README.md": readme,
    }
    stats = {
        "campaign_count": len(campaign_rows),
        "ad_group_count": len(ad_group_rows),
        "keyword_count": keyword_count,
        "ad_count": ad_count,
        "resolved_trials": len(resolved_trials),
        "skipped": skipped,
        "needs_url_fix": needs_url_fix,
        "total_budget": total_budget,
        "campaign_name": campaign_name,
    }
    return files, stats


def build_csv_zip(trials: list[dict], snapshot: list[dict]) -> tuple[bytes, dict]:
    """Build an importable ZIP and return (zip-bytes, stats)."""
    files, stats = build_importable_csvs(trials, snapshot)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        manifest = {
            "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
            "source_repo": "FreshlyBakedNYC/automation",
            "issue": "https://github.com/FreshlyBakedNYC/automation/issues/11",
            "campaign_name": stats.get("campaign_name"),
            "stats": {k: v for k, v in stats.items() if k not in ("skipped", "needs_url_fix")},
            "trials_needing_url_fix": stats.get("needs_url_fix", []),
        }
        zf.writestr("MANIFEST.json", json.dumps(manifest, indent=2))
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue(), stats


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
    <h2>📦 What the CSV bundle will create</h2>
    <div class="cards">
      <div class="stat"><div class="v {bundle_class}">{bundle_resolved}/{bundle_total}</div><div class="l">Trials resolved to a source ad group</div></div>
      <div class="stat"><div class="v">{bundle_campaigns}</div><div class="l">New campaign(s)</div></div>
      <div class="stat"><div class="v">{bundle_ad_groups}</div><div class="l">New ad group(s)</div></div>
      <div class="stat"><div class="v">{bundle_ads}</div><div class="l">New RSA(s) (Enabled)</div></div>
      <div class="stat"><div class="v">{bundle_keywords}</div><div class="l">Keyword(s)</div></div>
      <div class="stat"><div class="v">${bundle_budget:.2f}</div><div class="l">Campaign daily budget</div></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="title">Campaign: <span class="tag info">{bundle_campaign_name}</span></div>
      <div class="sub">All ad groups + ads are Enabled so the Google policy engine
      reviews them shortly after Ads Editor "Post". Defaults: Search /
      Google search / English / US / Manual CPC $1.00. Review locations &amp;
      bid strategy in Ads Editor before posting. Full instructions in
      the bundle's README.md.</div>
      {bundle_skipped_html}
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
    trials = flatten_trials(l2_runs)
    print(f"  flattened {len(trials)} trial(s) from L2 runs")
    print(f"  building importable CSV bundle ZIP...")
    csv_zip, csv_stats = build_csv_zip(trials, snapshot)
    csv_count = 0
    with zipfile.ZipFile(io.BytesIO(csv_zip)) as zf:
        csv_count = sum(1 for n in zf.namelist() if n.lower().endswith(".csv"))
    print(
        f"  ZIP: {csv_count} CSV(s), {len(csv_zip):,} bytes, "
        f"{csv_stats.get('resolved_trials', 0)}/{len(trials)} trials resolved, "
        f"{csv_stats.get('ad_count', 0)} ad row(s)"
    )
    if csv_stats.get("skipped"):
        for name, reason in csv_stats["skipped"]:
            print(f"    skipped trial {name!r}: {reason}")

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

    bundle_resolved = csv_stats.get("resolved_trials", 0)
    bundle_total = len(trials)
    bundle_class = "good" if bundle_resolved == bundle_total and bundle_total > 0 else ("warn" if bundle_resolved else "bad")
    skipped_items = csv_stats.get("skipped") or []
    needs_url_fix = csv_stats.get("needs_url_fix") or []
    notes_html_parts = []
    if needs_url_fix:
        items = "".join(f"<li>{_esc(n)}</li>" for n in needs_url_fix)
        notes_html_parts.append(
            f'<div class="sub" style="margin-top:8px;color:var(--warn);">'
            f"<b>⚠ {len(needs_url_fix)} trial(s)</b> had no Final URL on the "
            f"source ad (typical for disapproved ads); the bundle uses a "
            f"placeholder. Replace before posting in Ads Editor:"
            f'<ul class="snippets">{items}</ul></div>'
        )
    if skipped_items:
        items = "".join(
            f"<li>{_esc(name)} — {_esc(reason)}</li>" for name, reason in skipped_items
        )
        notes_html_parts.append(
            f'<div class="sub" style="margin-top:8px;color:var(--bad);">'
            f"<b>Skipped {len(skipped_items)} trial(s)</b> "
            f'(no matching ad group in the snapshot to clone from):'
            f'<ul class="snippets">{items}</ul></div>'
        )
    bundle_skipped_html = "".join(notes_html_parts)

    page = PAGE_TEMPLATE.format(
        csv_b64=base64.b64encode(csv_zip).decode("ascii"),
        generated_at=dt.datetime.now().strftime("%Y-%m-%d %H:%M %Z").strip(),
        trial_count=total_trials,
        csv_count=csv_count,
        total_trials=total_trials,
        total_variants=total_variants,
        persistent_count=len(persistent),
        total_budget=total_budget,
        bundle_resolved=bundle_resolved,
        bundle_total=bundle_total,
        bundle_class=bundle_class,
        bundle_campaigns=csv_stats.get("campaign_count", 0),
        bundle_ad_groups=csv_stats.get("ad_group_count", 0),
        bundle_ads=csv_stats.get("ad_count", 0),
        bundle_keywords=csv_stats.get("keyword_count", 0),
        bundle_budget=csv_stats.get("total_budget", 0.0),
        bundle_campaign_name=_esc(csv_stats.get("campaign_name") or "(none — no trials resolved)"),
        bundle_skipped_html=bundle_skipped_html,
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
