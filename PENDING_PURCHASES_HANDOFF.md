# Pending Purchases Proposal Packet Development — Handoff

## Current State (Updated 2026-05-12)

- **Manifest received**: PO 21 invoice from 10FF Distribution (5/6/2026, $21,532.50)
- **Packet created**: `pending_purchases_po21_packet.json` with 35 product lines parsed from invoice
- **Products include**: Flower (SmartBud, Runtz, Doobie Labs, Purps), Pre-Rolls (Preferred Gardens, Moonlit Hash Co, Jungle Girl, Herb), Vapes (Herb brand 1g carts)
- **Import script ready**: `import_po21_packet.ts` to load packet into Helios DB
- **Infrastructure reviewed**: Full pending-purchase system in `helios/src/` (contracts, routes, workers, DB queries)

## Immediate Next Steps

1. **Import PO 21 packet** into Helios database using import script
2. **Enrich packet rows** with:
   - Catalog matching (check existing products via `store.product.list.short`)
   - Lit Alerts market pricing data
   - Primary image suggestions
   - Cost basis from invoice
3. **Generate proposal HTML** review artifact with:
   - Product cards showing current/proposed catalog state
   - Market pricing comparisons
   - Action recommendations (create/link/review)
4. **Test apply workflow** for subset of rows to verify end-to-end flow
5. **Document** manual invoice import workflow for future POs

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
