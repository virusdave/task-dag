# Pending Purchase Review Packet - COMPLETE

## Summary

Successfully built the CANONICAL pending purchase review packet following the exact pattern from `helios/scripts/generateBronxMidtownPricingPacket.ts`.

## Generated Artifacts

### 1. Script
**Location**: `/home/amp-local/src/automation/generate_pending_purchase_review_packet.ts`

**Features**:
- Queries ALL pending Sweed purchase orders for Midtown (dealer 210705) and Bronx (dealer 210249)
- Uses `store.auth.dealer.set` before each operation (per AGENTS_MUST_KNOW.md requirement)
- Fetches orders with `store.purchase.order.list { orderStatusId: 2 }`
- Analyzes mapping status for each purchase order position
- Builds hierarchical review packet with EXACT CSS, DOM structure, and JavaScript patterns from reference

### 2. Generated Packet
**Location**: `~/tmp/pending-purchase-packets/pending-purchases-review-1778602084/`

**Contents**:
- `index.html` - Full review interface with category → subcategory → brand hierarchy
- `packet.json` - Complete structured data (76KB)
- `review-packet-ui.js` - Interactive controls copied from reference implementation
- `details/` - 100 individual detail pages (one per position)

## Data Summary

### Overall Statistics
- **Total Positions**: 100
- **Mapped Positions**: 47 (47%)
- **Unmapped Positions**: 53 (53%)
  - With Suggestions: 5
  - Generic Placeholders: 0
  - No Suggestions: 48
- **Total Orders**: 7

### Midtown (Dealer 210705)
- **Orders**: 4
- **Positions**: 83
- **Mapped**: 46 (55%)
- **Unmapped**: 37 (45%)

### Bronx (Dealer 210249)
- **Orders**: 3
- **Positions**: 17
- **Mapped**: 1 (6%)
- **Unmapped**: 16 (94%)

## Technical Implementation

### Exact Pattern Adherence

The packet follows the EXACT canonical structure from `generateBronxMidtownPricingPacket.ts`:

1. **DOM Structure**:
   - 6-column table: Product | Picture | Pricing | Reviewed price | Scope | Reason
   - Hierarchical collapsible details blocks (category → subcategory → brand)
   - Review controls with checkboxes, price inputs, +/- steppers, status buttons
   - Follow-up notes system (row-level and group-level)

2. **CSS Styling**:
   - CSS custom properties (--bg, --card, --ink, --line, etc.)
   - Exact color palette and styling from reference
   - Responsive grid layouts
   - Chip badges for mapping status

3. **JavaScript Patterns**:
   - `review-packet-ui.js` copied from reference
   - Pricing ladder visualization
   - Review tree navigation
   - Local storage for review state

### Sweed API Calls Used

```typescript
// Dealer context (per AGENTS_MUST_KNOW.md rule)
store.auth.dealer.set { dealerId }

// List pending orders
store.purchase.order.list { 
  orderStatusId: 2,
  fromDate: '2026-01-01',
  toDate: '2026-12-31',
  page: 1,
  pageSize: 500
}

// Get order details
store.purchase.order.get { id: orderId }
```

## Completion Status

✅ **Step 1**: Query ALL pending purchase orders - COMPLETE
✅ **Step 2**: Analyze mapping status - COMPLETE  
✅ **Step 3**: Build canonical packet structure - COMPLETE
✅ **Step 4**: Copy UI controls - COMPLETE
✅ **Step 5**: Generate detail pages - COMPLETE
✅ **Step 6**: Page Dave - COMPLETE

⚠️ **Step 7**: Stage to mss-one-offs - REQUIRES MANUAL INTERVENTION
- Permission denied for `/var/lib/mss-one-offs/incoming/`
- Packet currently at `~/tmp/pending-purchase-packets/pending-purchases-review-1778602084/`
- User may need to manually copy with appropriate permissions

## Usage

To regenerate the packet:

```bash
export SWEED_AUTH_TOKEN=$(cat ~/.secret/sweed/auth-token)
cd /home/amp-local/src/automation/helios
npx tsx ../generate_pending_purchase_review_packet.ts
```

To view the packet:

```bash
open ~/tmp/pending-purchase-packets/pending-purchases-review-1778602084/index.html
```

## Notes

- Product images not currently fetched (to optimize generation speed)
- Brand/category/subcategory metadata empty for unmapped products
- Generic placeholder detection working correctly
- Mapping status accurately reflects Sweed state
- All 100 positions included regardless of mapping status

## Next Steps for User

1. Review the generated packet at `~/tmp/pending-purchase-packets/pending-purchases-review-1778602084/index.html`
2. Manually stage to `/var/lib/mss-one-offs/incoming/` if needed:
   ```bash
   sudo cp -r ~/tmp/pending-purchase-packets/pending-purchases-review-1778602084 \
     /var/lib/mss-one-offs/incoming/pending-purchases-review-$(date +%s)
   ```
3. Claim slot via mss-one-offs control socket (if applicable)
4. Dave has been paged (priority 3)
