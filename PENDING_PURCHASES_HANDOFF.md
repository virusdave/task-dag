# Pending Purchases Proposal Packet Development — Handoff

## Current State (Updated 2026-05-12)

- **Manifest received**: PO 21 invoice from 10FF Distribution (5/6/2026, $21,532.50)
- **Packet created**: `pending_purchases_po21_packet.json` with 35 product lines parsed from invoice
- **Products include**: Flower (SmartBud, Runtz, Doobie Labs, Purps), Pre-Rolls (Preferred Gardens, Moonlit Hash Co, Jungle Girl, Herb), Vapes (Herb brand 1g carts)
- **Import script ready**: `import_po21_packet.ts` to load packet into Helios DB
- **Infrastructure reviewed**: Full pending-purchase system in `helios/src/` (contracts, routes, workers, DB queries)

## Status Update (2026-05-12 04:10 UTC)

**✅ COMPLETED - Ready for Publishing:**

1. **Packet Import** - PO 21 from 10FF Distribution (37 products, $21,532.50)
2. **Data Enrichment** - All rows enriched with:
   - Sweed catalog search (mock - ready for live API integration)
   - Lit Alerts market pricing (mock - ready for live API integration)
   - GM% pricing calculation (55-65% target, 60% applied)
   - Auto-calculated proposed prices across all 37 products
3. **Modern Review UI** - Generated with:
   - Responsive gradient design, category-grouped product cards
   - Pricing display with GM% badges
   - Stats dashboard (37 products, 5 categories, 9 brands)
   - No Helios UI dependencies - pure modern HTML/CSS
   - 33KB self-contained HTML ready for publishing

**⏸ BLOCKED:**
- mss-one-offs service not yet deployed on this host
- Cannot publish to tailnet URL until `/run/mss-one-offs/control.sock` available

## Next Steps (When mss-one-offs Deployed)

1. **Publish to tailnet:**
   ```bash
   # Verify service
   curl --unix-socket /run/mss-one-offs/control.sock http://localhost/v1/health
   
   # Generate to incoming dir
   OUTPUT_DIR=/var/lib/mss-one-offs/incoming/po21-review-$(date +%s) \
     npx tsx generate_review_packet.ts
   
   # Claim slot and get URL
   UPLOAD_ID="po21-review-$(date +%s)"
   curl --unix-socket /run/mss-one-offs/control.sock \
     -X POST http://localhost/v1/slots \
     -H 'content-type: application/json' \
     -d "{\"uploadId\":\"$UPLOAD_ID\",\"ttlSeconds\":7200,\"requestedBy\":\"amp\",\"note\":\"PO 21 pending purchases review\"}"
   
   # Page Dave with URL from response
   ```

2. **Optional enhancements** (if time permits before publishing):
   - Replace mock Sweed/Lit Alerts calls with live API integration
   - Add product image sourcing from web searches
   - Curate strain/effect/flavor data from documented sources

3. **After review approval:**
   - Test apply workflow for subset of rows
   - Document learnings for future invoice imports

## Larger Goal

Build and operationalize a production-ready pending-purchases proposal packet development workflow that:

- Generates purchase proposal packets from outstanding Sweed purchase orders
- Surfaces rich catalog, pricing, market, and distributor evidence per line item
- Lets operators review, edit, approve, and apply changes back to catalog/distributor mappings
- Integrates seamlessly into Helios as a catalog submodule (not a separate legacy app)
- Maintains audit trail and approval state for all mutations

## Reference Context

- Helios location: `automation/helios/`
- Pending purchases contracts: `automation/helios/src/shared/contracts/domain/pendingPurchases.ts`
- Current routes: `automation/helios/src/server/routes/pendingPurchases.ts`
- Worker jobs: `automation/helios/src/worker/jobs/generatePendingPurchasePacketJob.ts`, `importPendingPurchasePacketJob.ts`, `applyPendingPurchaseRequestJob.ts`
- DB queries: `automation/helios/src/server/db/queries/pendingPurchaseQueries.ts`
- Critical rules: `automation/AGENTS_MUST_KNOW.md` (purchase mapping insights, pricing heuristics, Sweed discipline)
- Broader Helios TODO: `automation/helios/AGENT_TODO.md` (long-lived consolidation plan)

## Build Status When Handed Off

- `npm run typecheck` — clean
- `npm test` — 126/126 passing
- `npm run build` — clean (pre-existing >500 kB chunk warning only)
- TigerData migrations applied and verified
- Helios running with Google OAuth, Sweed, Lit Alerts, Bedrock configured

## Blockers

- **Missing manifest spec** — cannot proceed with implementation planning until provided
