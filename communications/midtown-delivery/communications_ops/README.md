# Communications Ops

Standalone Freshly Baked NYC communications operations app.

## Local Pattern Reused

This app deliberately mirrors the existing standalone app pattern already present in the workspace under `helios`:

- React + Vite + TypeScript client
- Fastify + TypeScript API
- TypeScript worker
- Postgres-ready workflow shape for the next iteration

## What This First Cut Delivers

This initial version is a read-heavy operator shell backed by live Sweed mirrors of the tracked Midtown/Bronx marketing state in this queue.

It is designed around four operator jobs:

- review communications already live in Sweed
- inspect selected segments and sample customers
- preview Email/Text content with fast access to full details
- see the planned performance dashboard stack before wiring the full BI sync path

The app intentionally keeps the architecture decisions visible in the UI so the next implementation pass can move directly into live Sweed reads and BI snapshot ingestion.

## Architecture Decisions

Oracle plus the local Gemma and DeepSeek models converged on the same shape:

- keep Sweed as the execution system for events, triggers, and segments
- keep Cube analytics server-side behind Fastify
- model campaigns and A/B experiments locally instead of assuming a native Sweed campaign analytics primitive
- treat one Sweed marketing event as one communication run
- compare experiments as multiple communications linked into one local experiment record

## Current Runtime Shape

- the Fastify API serves serialized live Sweed mirrors for the tracked queue, always resetting to Midtown dealer `210705` before each store-scoped read block
- the Fastify API now also serves live event-performance read-through at `/api/communications/:id/performance`, minting `store.bi.auth.jwt` inside the same serialized store-scoped block and querying `MarketingStat` plus `store.bi.cube.totals` server-side
- the Fastify API now also persists operator schedule/audience/trigger preview/apply history into TigerData and exposes it on the communication detail route so write intent survives restarts
- the worker now persists mirrored communications, segment previews, and event-performance snapshots into the TigerData-backed `communications_ops` schema
- the portfolio dashboard now rolls up those persisted snapshots instead of reading only static blueprint copy
- the app now also persists local campaign rollups and experiment-compare snapshots built from those stored child-event analytics rows
- the React client renders the operator workflow and dashboard blueprint against that snapshot
- the communication detail page now opens into live BI-backed overview cards, channel split rows, daily trend rows, and footer totals for the tracked events
- the Campaigns and Experiments routes now sit on the persisted path, while the communication detail route remains the live BI read-through surface
- the worker sequence now runs `analytics_snapshot_refresh`, `mirror_persist`, and `experiment_rollup_refresh` in order on a loop, with the final step persisting local campaign and experiment rollups instead of no-oping

## Runtime Requirements

- Provide `SWEED_AUTH_TOKEN` or `SWEED_AUTH_TOKEN_FILE`, or place the token in `/Users/amp-local/.secret/sweed/auth-token`.
- Provide `DATABASE_URL` or `DATABASE_URL_FILE`, or let the app auto-discover the current TigerData credentials from `/Users/amp-local/.secret/tigerdata`.
- Optional overrides:
  - `PORT`
  - `SWEED_API_URL`
  - `SWEED_REQUEST_TIMEOUT_MS`
  - `LIVE_MIRROR_TTL_MS`
  - `TIGERDATA_CREDENTIALS_FILE`
  - `WORKER_POLL_INTERVAL_MS`
  - `WORKER_RUN_ONCE`

## Scripts

- `npm run dev`
- `npm run build`
- `npm run typecheck`
- `npm run db:migrate`
- `npm run db:status`

## Immediate Next Iterations

1. Add richer audience tooling such as segment search once more live store segments need to be swapped from the UI.
2. Add stronger publish confirmations for genuinely state-changing trigger enables.
3. Persist rollup history, not just the latest mirror and analytics state, once operators need historical trend comparisons inside the app.
4. Expand the local campaign and experiment definition set as more tracked live events are added.
5. Keep campaign and experiment dashboards on top of persisted event snapshots until a native Sweed campaign analytics primitive is actually proven.
