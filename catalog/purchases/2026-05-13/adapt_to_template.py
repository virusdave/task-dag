#!/usr/bin/env python3
"""Adapt 2026-05-13 data into the 2026-05-11 HTML template format."""

import json
import re
from pathlib import Path

WORKDIR = Path(__file__).parent
TEMPLATE_HTML = WORKDIR.parent / "2026-05-11" / "combined_pending_purchases_proposal.html"
OUR_JSON = WORKDIR / "pending_purchases_2026_05_13.json"
OUTPUT_HTML = WORKDIR / "phase_d_adapted.html"

# Load our data
our_data = json.loads(OUR_JSON.read_text())

# Load template
template = TEMPLATE_HTML.read_text()

# Update max-width
template = template.replace('max-width: 1780px', 'max-width: 95%')

# Update title and header
template = template.replace(
    'Combined pending-purchases catalog mutation proposal - 2026-05-11',
    'Phase D Review: Pending Purchases 2026-05-14'
)
template = template.replace('2026-05-11', '2026-05-14')

# Replace the embedded JSON data
# Find the script block that contains the original data
json_pattern = r'var PACKET_DATA = (\{.*?\});'
new_json_str = 'var PACKET_DATA = ' + json.dumps(our_data, indent=2, default=str) + ';'

if 'var PACKET_DATA' in template:
    template = re.sub(json_pattern, new_json_str, template, flags=re.DOTALL)
else:
    # If there's no embedded data variable, we need to inject our data differently
    # Just replace the JSON data reference in the script
    print("No PACKET_DATA variable found - will need different approach")

OUTPUT_HTML.write_text(template)
print(f"Generated {OUTPUT_HTML}")
print(f"Size: {len(template)} bytes")
