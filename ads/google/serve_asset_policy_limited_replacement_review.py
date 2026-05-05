#!/usr/bin/env python3
"""Legacy fallback backing service for the policy-limited asset replacement review packet.

SUPERSEDED on 2026-05-05 by the Helios ``communications`` module.

The canonical reviewer surface for the policy-limited Google Ads asset
replacement review is now in Helios at
``/communications/policy-replacements/<packetId>`` (Helios server route
``/api/communications/policy-replacements/<packetId>/draft``). This script is
retained as an offline fallback for emergencies when the Helios stack is
unavailable; the persisted draft and audit chain on the Helios side are not
synced from the legacy state file under
``policy/asset_policy_limited_replacement_review_state.json``.

Original purpose (still accurate for offline use):

This is the small server-wrap step that lets the static HTML packet under
``policy/asset_policy_limited_replacement_plan_*.html`` be reviewed against a
server-persisted draft instead of only browser ``localStorage``. The endpoint
shape and review-state schema are intentionally close to
``serve_midtown_brands_conquest_review.py`` so the same Helios-bound pattern
could be folded in -- which has now happened in
``helios/src/server/routes/communications.ts``.

Important:
- This service does NOT mutate Google Ads. It only persists reviewer
  decisions and edited replacement text against the static packet.
- Any apply phase still requires the narrow post-review Google Ads resolver
  pass documented in ``docs/google-ads/review-packets.md``: validate-only,
  then live apply, then a narrow readback.
- Only entries with ``decision == accepted`` should flow into a downstream
  resolver/apply script. Rejected and hold entries must stay out of any
  live mutate.
"""
from __future__ import annotations

import argparse
import json
import re
import time
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


SCRIPT_DIR = Path(__file__).resolve().parent
POLICY_DIR = SCRIPT_DIR / "policy"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8795
DEFAULT_STATE_PATH = POLICY_DIR / "asset_policy_limited_replacement_review_state.json"
PACKET_GLOB = "asset_policy_limited_replacement_plan_*.json"
MAX_BODY_BYTES = 2_000_000

ALLOWED_DECISIONS = {"unreviewed", "accepted", "rejected", "hold"}
ALLOWED_FIELD_KEYS = {"text", "note", "replacementCategory", "sourceId"}
ALLOWED_CATEGORIES = {"location", "price", "pickup", "payment"}
MAX_FIELD_LEN = 1000

API_BASE = "/api/asset-policy-limited-replacement-review"


def latest_packet_json() -> Path:
    candidates = sorted(POLICY_DIR.glob(PACKET_GLOB))
    # Filter out timestamp-suffixed snapshots like ..._110134_205959.json so we
    # pick the canonical packet rather than an autosave-style sibling.
    primary = [p for p in candidates if re.fullmatch(
        r"asset_policy_limited_replacement_plan_\d{4}-\d{2}-\d{2}_\d{6}\.json",
        p.name,
    )]
    chosen = primary or candidates
    if not chosen:
        raise RuntimeError(
            "No asset_policy_limited_replacement_plan_*.json packet found under "
            f"{POLICY_DIR}. Build the planning packet first."
        )
    return chosen[-1]


def html_for(packet_json: Path) -> Path:
    candidate = packet_json.with_suffix(".html")
    if not candidate.exists():
        raise RuntimeError(f"Companion HTML packet not found at {candidate}")
    return candidate


def load_packet(packet_path: Path) -> dict[str, Any]:
    return json.loads(packet_path.read_text())


def allowed_item_ids(packet: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for index, _ in enumerate(packet.get("visualReplacementPlans") or [], start=1):
        ids.add(f"visual-{index}")
    llm = packet.get("llmCopy") or {}
    for index, _ in enumerate(llm.get("headlines") or [], start=1):
        ids.add(f"headline-{index}")
    for index, _ in enumerate(llm.get("longHeadlines") or [], start=1):
        ids.add(f"long-headline-{index}")
    for index, _ in enumerate(llm.get("descriptions") or [], start=1):
        ids.add(f"description-{index}")
    for index, _ in enumerate(llm.get("templateFamilies") or [], start=1):
        ids.add(f"template-family-{index}")
    for mapping in packet.get("textReplacementMappings") or []:
        mapping_id = str(mapping.get("mappingId") or "").strip()
        if mapping_id:
            ids.add(mapping_id)
    return ids


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def normalize_decision(value: Any) -> str:
    text = str(value or "unreviewed")
    return text if text in ALLOWED_DECISIONS else "unreviewed"


def normalize_fields(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    fields: dict[str, str] = {}
    for raw_key, raw_value in value.items():
        key = str(raw_key)
        if key not in ALLOWED_FIELD_KEYS:
            continue
        if raw_value is None:
            continue
        text = str(raw_value)[:MAX_FIELD_LEN]
        if key == "replacementCategory" and text and text not in ALLOWED_CATEGORIES:
            continue
        fields[key] = text
    return fields


def normalize_items(payload_items: Any, allowed_ids: set[str]) -> dict[str, dict[str, Any]]:
    if not isinstance(payload_items, dict):
        return {}
    normalized: dict[str, dict[str, Any]] = {}
    for raw_id, raw_value in payload_items.items():
        item_id = str(raw_id).strip()
        if not item_id or item_id not in allowed_ids:
            continue
        if not isinstance(raw_value, dict):
            continue
        decision = normalize_decision(raw_value.get("decision"))
        fields = normalize_fields(raw_value.get("fields"))
        if decision == "unreviewed" and not fields:
            continue
        normalized[item_id] = {"decision": decision, "fields": fields}
    return normalized


def read_state(state_path: Path) -> dict[str, Any] | None:
    if not state_path.exists():
        return None
    raw = state_path.read_text()
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def write_state(state_path: Path, payload: dict[str, Any]) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(payload, indent=2) + "\n")


def filtered_state_payload(
    state: dict[str, Any],
    allowed_ids: set[str],
    packet_id: str,
) -> dict[str, Any]:
    return {
        "version": 1,
        "packetId": packet_id,
        "savedAt": state.get("savedAt"),
        "submittedAt": state.get("submittedAt"),
        "items": normalize_items(state.get("items") or {}, allowed_ids),
    }


class ReviewHandler(SimpleHTTPRequestHandler):
    def __init__(
        self,
        *args: Any,
        directory: str,
        packet_path: Path,
        html_path: Path,
        state_path: Path,
        **kwargs: Any,
    ) -> None:
        self.packet_path = packet_path
        self.html_path = html_path
        self.state_path = state_path
        super().__init__(*args, directory=directory, **kwargs)

    def _json_response(self, status_code: int, payload: dict[str, Any]) -> None:
        body = (json.dumps(payload, indent=2) + "\n").encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html_response(self, body: bytes) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("Invalid request body length.")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == f"{API_BASE}/draft/latest":
            packet = load_packet(self.packet_path)
            ids = allowed_item_ids(packet)
            packet_id = str(packet.get("packetId") or "")
            state = read_state(self.state_path)
            if state is None:
                self._json_response(
                    HTTPStatus.NOT_FOUND,
                    {"error": "No saved review state exists yet.", "packetId": packet_id},
                )
                return
            self._json_response(HTTPStatus.OK, filtered_state_payload(state, ids, packet_id))
            return
        if parsed.path in {"/", "/index.html"}:
            self._html_response(self.html_path.read_bytes())
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != f"{API_BASE}/draft":
            self._json_response(HTTPStatus.NOT_FOUND, {"error": "Unknown endpoint."})
            return
        try:
            packet = load_packet(self.packet_path)
            body = self._read_json_body()
            packet_id = str(packet.get("packetId") or "")
            if str(body.get("packetId") or "") != packet_id:
                self._json_response(
                    HTTPStatus.CONFLICT,
                    {"error": "Packet id mismatch. Reload the packet and try again."},
                )
                return
            ids = allowed_item_ids(packet)
            items = normalize_items(body.get("items") or {}, ids)
            mark_submitted = bool(body.get("submit"))
        except ValueError as exc:
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        except json.JSONDecodeError:
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Request body was not valid JSON."})
            return
        except Exception as exc:  # pragma: no cover - defensive
            self._json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return

        prior = read_state(self.state_path) or {}
        submitted_at = (
            now_iso() if mark_submitted else (str(prior.get("submittedAt") or "") or None)
        )
        payload = {
            "version": 1,
            "packetId": packet_id,
            "savedAt": now_iso(),
            "submittedAt": submitted_at,
            "items": items,
        }
        write_state(self.state_path, payload)
        self._json_response(HTTPStatus.OK, payload)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Serve the policy-limited asset replacement review packet with "
            "server-persisted reviewer state."
        )
    )
    parser.add_argument("--packet", type=Path, default=None, help="Path to packet JSON.")
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE_PATH)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    packet_path = (args.packet or latest_packet_json()).resolve()
    html_path = html_for(packet_path).resolve()
    state_path = args.state.resolve()
    handler = partial(
        ReviewHandler,
        directory=str(packet_path.parent),
        packet_path=packet_path,
        html_path=html_path,
        state_path=state_path,
    )
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Policy-limited asset replacement review service listening at http://{args.host}:{args.port}")
    print(f"Serving HTML packet from {html_path}")
    print(f"Validating against packet JSON {packet_path}")
    print(f"Saving review state to {state_path}")
    print(
        "Reminder: This service only persists reviewer decisions. Any apply phase "
        "must run a narrow post-review Google Ads resolver pass first."
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
