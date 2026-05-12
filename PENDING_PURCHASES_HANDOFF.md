# Pending Purchases Proposal Packet Development — Handoff

## Current State (Updated 2026-05-12)

- **Manifest received**: PO 21 invoice from 10FF Distribution (5/6/2026, $21,532.50)
- **Packet created**: `pending_purchases_po21_packet.json` with 35 product lines parsed from invoice
- **Products include**: Flower (SmartBud, Runtz, Doobie Labs, Purps), Pre-Rolls (Preferred Gardens, Moonlit Hash Co, Jungle Girl, Herb), Vapes (Herb brand 1g carts)
- **Import script ready**: `import_po21_packet.ts` to load packet into Helios DB
- **Infrastructure reviewed**: Full pending-purchase system in `helios/src/` (contracts, routes, workers, DB queries)

## Status Update (2026-05-12 03:35 UTC)

**Completed:**
- ✅ PO 21 packet imported (Packet ID 8, 37 rows in Helios DB)
- ✅ Reviewed mss-one-offs service documentation (`docs/HOW_ONE_OFFS_WORKS.md`)
- ✅ Switched to `feature/mss-one-offs` branch in mostly-static-sites repo

**Blocked/Waiting:**
- ⏸ mss-one-offs service not yet deployed on this host (no `/run/mss-one-offs/control.sock`)
- User requested modern UI review page via one-offs service (not Helios UI)

## Next Steps (Resume When Service Available)

1. **Verify mss-one-offs service** is running:
   ```bash
   curl --unix-socket /run/mss-one-offs/control.sock http://localhost/v1/health
   ```
2. **Enrich packet rows** with catalog matching and pricing:
   - Query Sweed for existing products
   - Fetch Lit Alerts market data
   - Calculate proposed prices with GM% targets
3. **Generate modern review UI** using modern components (shadcn/ui):
   - Product cards with images, current/proposed state
   - Market pricing comparison charts
   - Inline approval/edit controls
4. **Publish via one-offs**:
   - Stage HTML to `/var/lib/mss-one-offs/incoming/<uploadId>/`
   - POST to control socket to claim slot
   - Page Dave with the tailnet URL
5. **Test apply workflow** after approval

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
