# Pending Purchase Review Packet - Current Status

## What Happened

I initially created a duplicate system from scratch (`generate_pending_purchase_review_packet.ts`) instead of using the existing canonical generator at `catalog/purchases/2026-05-11/`.

The duplicate was **wrong** on multiple levels:
- Used wrong cost fields (package vs unit)
- No competitor analysis
- No canonical UI patterns
- Missing image sourcing
- Non-canonical structure

**I deleted the duplicate script** and am now working with the existing canonical system.

## Existing Canonical System

Located at: `catalog/purchases/2026-05-11/`

**Generator**: `generate_combined_pending_packet.py`
- Uses legacy 2026-04-13 pipeline with runtime patches
- Manifest-first parsing for Stop 31 SKUs
- LitAlerts competitor analysis integration
- Proper unit cost calculation
- GM% pricing with brand-specific overrides
- Canonical UI from `helios/scripts/generateBronxMidtownPricingPacket.ts`
- Tree navigation, pricing ladders, review controls

**Current Work State** (per `HANDOFF.md`):
- Stop 31 LLC (Midtown order 131845) + N&M Farms (Bronx order 131642)
- First round had bad LLM decoding → 41 products + 41 groups disabled
- Manifest from 10FF Distribution PDF now source of truth (32 SKUs corrected)
- Bronx entries are correct and live
- Midtown needs regeneration + re-apply

## Current Blocker

**LitAlerts bearer token expired (401)**

Need: Fresh `brands.litalerts.com` HAR with Cognito `GetTokensFromRefreshToken` call

### What I Did

1. ✅ Created refresh script: `litalerts/refresh_bearer_token.py`
2. ✅ Paged Dave (priority 3) for fresh HAR with refresh token
3. ✅ Created symlink for missing HAR file
4. ⏳ Waiting for refresh token to provision `~/.secret/litalerts/refresh-token`

### Refresh Flow (per `docs/litalerts/foundations.md`)

Once Dave provides HAR:
```bash
# Extract RefreshToken from HAR's Cognito call body and save
echo "REFRESH_TOKEN_HERE" > ~/.secret/litalerts/refresh-token
chmod 600 ~/.secret/litalerts/refresh-token

# Run refresh script
python3 litalerts/refresh_bearer_token.py

# Should output:
# [refresh] Calling Cognito GetTokensFromRefreshToken...
# [refresh] Got AccessToken (expires in 86400s)
# [verify] Testing token against https://public-api.litalerts.com/...
# [verify] Token verified (HTTP 200)
# [success] Wrote bearer token to /home/amp-local/.secret/litalerts/bearer-token
```

## Next Steps (Once LitAlerts Works)

### Step 1: Regenerate with Manifest Corrections

```bash
cd /home/amp-local/src/automation/catalog/purchases/2026-05-11
python generate_combined_pending_packet.py
```

Should output:
- `[patches] manifest overrides: 36` (32 Stop 31 + context)
- Clean generation for all rows
- `combined_pending_purchases_proposal.{html,json}`

### Step 2: Query ALL Current Pending Orders

The generator already supports this via the `SITES` list. Currently set to:
- Midtown (210705)
- Bronx (210249)

To expand to ALL pending orders across both sites, the generator's `collect_pending_groups()` already:
1. Calls `store.auth.dealer.set` per site
2. Lists ALL pending orders via `store.purchase.order.list { orderStatusId: 2 }`
3. Fetches each order's positions
4. Groups unmapped positions by distributor product

**No code changes needed** - it already queries ALL pending orders per configured site.

### Step 3: Improvements Per HANDOFF.md

1. **Dutchie image pre-filter** in generator (currently only apply strips them)
2. **METRC tag stamping** onto rows for reviewer visibility  
3. **Review in browser** (serve via mss-one-offs or local http.server)
4. **Apply Midtown corrections** only (Bronx already live)
5. **Image quality pass** (deferred)
6. **Page Dave** on completion

## Alternative: Modern TypeScript Workflow

There's also a modern Helios-based workflow:
- `enrich_po21_packet.ts` - Enrichment with parallel processing
- `generate_review_packet.ts` - Modern gradient UI (no Helios deps)
- Uses Postgres `pending_purchase_rows` table
- Already working for PO 21 packet

This could be adapted for ALL pending orders, but would require:
1. Helios database setup
2. Import/sync from Sweed to pending_purchase_rows
3. Parallel enrichment with Sweed + LitAlerts APIs
4. Modern UI generation

## Files Created/Modified This Session

- ✅ `litalerts/refresh_bearer_token.py` - Cognito refresh automation
- ✅ `bulk_additions/2026-04-10/brands.litalerts.com_Archive...har` - Symlink
- ❌ `generate_pending_purchase_review_packet.ts` - DELETED (was duplicate/wrong)
- ✅ `PENDING_PURCHASE_STATUS.md` - This file

## Waiting On

**Dave to provide**: Fresh `brands.litalerts.com` HAR with Cognito refresh token

See page-dave message ID: `ajEKY5Bzax65`
