# Upload Instructions for Phase D Review

## File Generated

`phase_d_review_integrated.html` (264KB)

## To Upload to mss-one-offs

Run this command (requires sudo access to the mss-one-offs server):

```bash
HTML_FILE="catalog/purchases/2026-05-13/phase_d_review_integrated.html"
UPLOAD_ID="phase-d-$(date +%s)-$(openssl rand -hex 4)"
INCOMING_DIR="/var/lib/mss-one-offs/incoming/${UPLOAD_ID}"

# Create upload directory
sudo mkdir -p "${INCOMING_DIR}"

# Copy HTML file
sudo cp "${HTML_FILE}" "${INCOMING_DIR}/index.html"

# Set permissions
sudo chgrp -R mss-one-offs "${INCOMING_DIR}"
sudo chmod -R g+w "${INCOMING_DIR}"

# Claim slot and get URL
URL=$(sudo curl --unix-socket /run/mss-one-offs/control.sock \
  -sS -X POST http://localhost/v1/slots \
  -H 'content-type: application/json' \
  -d "{\"uploadId\":\"${UPLOAD_ID}\",\"ttlSeconds\":86400,\"requestedBy\":\"amp\",\"note\":\"Phase D Review 2026-05-13 - Integrated modular UI\"}" | jq -r '.url')

echo "✅ Upload successful!"
echo "URL: ${URL}"
```

## What's Included

The generated HTML includes:

### Integrated Components
- **PriceStepControl**: ±$0.25 buttons for each product row
- **ApprovalToggle**: Approve/reject at row and group levels
- **CompetitorSummary**: Inline market metrics (median, range, top price)
- **CompetitorDrawer**: Side panel with full competitor data (no new tabs)
- **StateManager**: Auto-save to localStorage + export to JSON
- **ReviewTreeNav**: Hierarchical navigation with state persistence

### Data
- 55 products from 2026-05-13 pending purchases
- Market research with LitAlerts competitor data
- Hierarchical grouping: Site → Category → Subcategory → Variant → Brand

### Features
- Fixed nav sidebar bug (grid-template-columns)
- Pricing ladders with visual markers
- Real-time GM calculations
- Group-level bulk operations
- Competitor drawer (Esc to close, click outside to close)
- Export changes to JSON
- Auto-save with "Last saved" indicator

## Testing Locally

Open the file directly in a browser:

```bash
open catalog/purchases/2026-05-13/phase_d_review_integrated.html
# or
firefox catalog/purchases/2026-05-13/phase_d_review_integrated.html
```

All JavaScript is embedded (no external dependencies).

## Implementation Summary

This is Option B - **Full modular integration**:
- ✅ All 5 core UI components implemented and integrated
- ✅ Real data from 2026-05-13 purchases + market research
- ✅ Hierarchical navigation with tree nav
- ✅ State persistence (localStorage)
- ✅ Export functionality
- ✅ Responsive design
- ✅ Accessible (ARIA labels, keyboard shortcuts)

Next steps would be:
- Hierarchical price cascade with confirmation
- MSO brand marking
- Additional keyboard shortcuts (↑↓←→ A/R)
- Server-side persistence endpoint
- Visual state indicators in nav tree
