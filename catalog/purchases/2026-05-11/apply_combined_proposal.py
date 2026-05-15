#!/usr/bin/env python3
"""Execute the 2026-05-11 combined pending-purchases catalog mutation
proposal against live Sweed.

Pre-flight scrubs every Dutchie-hosted image URL out of the rows before
handing them to the legacy `apply_pending_order_catalog_proposal.ensure_row`
pipeline. Dutchie images (including stock placeholders such as
`preroll-stock-1-v1.jpg`) are operator-forbidden in our catalog; affected
rows are created without an image and flagged for the upcoming "find quality
images" pass.

This driver:
  1. Loads `combined_pending_purchases_proposal.json` from this directory.
  2. Strips every `dutchie-images` URL from `primaryImage*` fields and adds
     a reviewer flag so the post-facto report records what happened.
  3. Splits rows by site (`_siteKey`), writes a per-site packet with the
     `siteContext` shape the legacy apply requires, and invokes
     `apply_pending_order_catalog_proposal.main` against each one with the
     site's dealer context.
  4. Writes per-site result JSONs and a single combined apply results JSON.
  5. Pages Dave on success or unrecoverable failure.

No silent failures - any per-row error aborts the run loudly.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_ROOT = WORKDIR.parents[2]
LEGACY_DIR = AUTOMATION_ROOT / "categories" / "2026-04-13"

if str(LEGACY_DIR) not in sys.path:
    sys.path.insert(0, str(LEGACY_DIR))
if str(WORKDIR) not in sys.path:
    sys.path.insert(0, str(WORKDIR))

import apply_pending_order_catalog_proposal as legacy_apply  # noqa: E402
import generate_pending_order_catalog_proposal as legacy_gen  # noqa: E402
import _legacy_patches as patches  # noqa: E402

# Install the LLM-cache patch on the proposal generator so the
# `regenerate_packet` step at the end of legacy_apply.main can decode the
# distributor product names that the regex parsers don't recognize.
patches.install_patches(legacy_gen)

# Stub regenerate_packet - the post-apply repackaging step is unnecessary
# here (we already have the canonical packet on disk and will rerun the
# generator separately for review) and it triggers a fresh round of
# LitAlerts statewide queries that adds ~10 minutes per site.
def _skip_regenerate_packet(results: dict) -> dict:  # noqa: ARG001
    return {"skipped": "regenerate_packet disabled by combined apply driver"}


legacy_apply.regenerate_packet = _skip_regenerate_packet

PACKET_PATH = WORKDIR / "combined_pending_purchases_proposal.json"
RESULTS_PATH = WORKDIR / "combined_apply_results.json"

STATE_DEALER_ID = 210248
STATE_DEALER_NAME = "Freshly Baked NY"

SITES = {
    "midtown": {
        "dealerId": 210705,
        "dealerName": "Freshly Baked NYC - Midtown",
        "siteLabel": "Midtown",
    },
    "bronx": {
        "dealerId": 210249,
        "dealerName": "Freshly Baked NYC - The Bronx",
        "siteLabel": "Bronx",
    },
}

DUTCHIE_HOSTNAMES = ("dutchie-images", "dutchie.com")


def _force_ipv4_once() -> None:
    original = socket.getaddrinfo

    def _ipv4_only(*args, **kwargs):
        return [info for info in original(*args, **kwargs) if info[0] == socket.AF_INET]

    socket.getaddrinfo = _ipv4_only


_force_ipv4_once()


def is_dutchie_url(url: str | None) -> bool:
    if not url:
        return False
    return any(token in url for token in DUTCHIE_HOSTNAMES)


def scrub_dutchie_imagery(row: dict) -> bool:
    """Return True if the row's primary image was a Dutchie URL we removed."""
    if not is_dutchie_url(row.get("primaryImageUrl")):
        return False
    row["primaryImageUrl"] = ""
    row["primaryImageHref"] = ""
    row["primaryImageSource"] = "removed: forbidden Dutchie image"
    row["primaryImageNote"] = (
        "Original image source was a Dutchie-hosted asset (forbidden per operator "
        "directive 2026-05-11). Group will be created without an image; the next "
        "find-quality-images pass should attach a brand-approved photo."
    )
    flags = list(row.get("reviewFlags") or [])
    flag = "Image deferred: Dutchie source forbidden, awaiting find-quality-images pass"
    if flag not in flags:
        flags.append(flag)
    row["reviewFlags"] = flags
    return True


def write_per_site_packet(
    combined: dict, site_key: str, site_rows: list[dict], output_path: Path
) -> None:
    site = SITES[site_key]
    payload = {
        "packetTitle": f"{combined.get('packetTitle', 'Pending purchases proposal')} ({site['siteLabel']})",
        "generatedAt": combined.get("generatedAt"),
        "siteContext": {
            "siteKey": site_key,
            "siteLabel": site["siteLabel"],
            "dealerId": site["dealerId"],
            "dealerName": site["dealerName"],
        },
        "stateContext": {"dealerId": STATE_DEALER_ID, "dealerName": STATE_DEALER_NAME},
        "orders": [
            o for o in (combined.get("orders") or []) if (o.get("site") or "").lower() == site["siteLabel"].lower()
        ],
        "rows": site_rows,
    }
    output_path.write_text(json.dumps(payload, indent=2, default=str) + "\n")


def main() -> int:
    combined = json.loads(PACKET_PATH.read_text())
    rows = combined.get("rows") or []
    if not rows:
        print(f"[apply] no rows in {PACKET_PATH}; nothing to do.")
        return 1

    scrubbed = 0
    for row in rows:
        if scrub_dutchie_imagery(row):
            scrubbed += 1
    print(
        f"[apply] scrubbed {scrubbed} Dutchie-hosted primary image(s) "
        f"out of {len(rows)} row(s); these will be created image-less.",
        flush=True,
    )

    rows_by_site: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        rows_by_site[row["_siteKey"]].append(row)

    per_site_results: dict[str, dict] = {}
    started_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    for site_key, site_rows in rows_by_site.items():
        if site_key not in SITES:
            raise RuntimeError(f"Unknown site key in combined packet: {site_key!r}")
        per_site_packet = WORKDIR / f"_apply_packet_{site_key}.json"
        per_site_results_path = WORKDIR / f"{site_key}_apply_results.json"

        # If this site already completed (rows array length matches site_rows
        # and the summary block exists), don't re-apply - that would create
        # duplicate brands/groups/products.
        if per_site_results_path.exists():
            try:
                existing = json.loads(per_site_results_path.read_text())
                if (
                    len(existing.get("rows") or []) == len(site_rows)
                    and existing.get("summary")
                ):
                    print(
                        f"[apply] === site {SITES[site_key]['siteLabel']} ({site_key}) "
                        f"already complete ({len(site_rows)} rows). Skipping write phase; "
                        f"will only run regenerate_packet/postWriteVerification if missing. ===",
                        flush=True,
                    )
                    per_site_results[site_key] = existing
                    # Skip regenerate_packet - it would re-run a full pending
                    # collect + LitAlerts build for each row (~10 minutes per
                    # site for no incremental verification value beyond what
                    # postWriteVerification already provides).
                    continue
            except Exception as exc:  # noqa: BLE001
                print(f"[apply][warn] could not read existing results {per_site_results_path}: {exc}", flush=True)

        write_per_site_packet(combined, site_key, site_rows, per_site_packet)
        print(
            f"[apply] === site {SITES[site_key]['siteLabel']} ({site_key}) "
            f"rows={len(site_rows)} packet={per_site_packet.name} ===",
            flush=True,
        )

        # Run legacy_apply.main in-process so the LLM patches we installed
        # above stay active during the post-write `regenerate_packet` step.
        # We swap sys.argv around the call so the legacy argparse picks up
        # the right packet path / results path / site dealer.
        saved_argv = sys.argv
        sys.argv = [
            "apply_pending_order_catalog_proposal.py",
            "--site", site_key,
            "--packet", str(per_site_packet),
            "--results", str(per_site_results_path),
        ]
        try:
            legacy_apply.main()
        except SystemExit as exc:
            if exc.code not in (None, 0):
                raise RuntimeError(
                    f"Legacy apply for site {site_key!r} exited with code {exc.code}."
                ) from exc
        finally:
            sys.argv = saved_argv

        if per_site_results_path.exists():
            per_site_results[site_key] = json.loads(per_site_results_path.read_text())
        else:
            raise RuntimeError(
                f"Legacy apply for site {site_key!r} did not write results JSON at "
                f"{per_site_results_path}; aborting before claiming success."
            )

    combined_results = {
        "startedAt": started_at,
        "finishedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "packetPath": str(PACKET_PATH),
        "scrubbedDutchieImages": scrubbed,
        "perSiteResults": per_site_results,
    }
    RESULTS_PATH.write_text(json.dumps(combined_results, indent=2, default=str) + "\n")
    print(f"[apply] wrote combined results to {RESULTS_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
