# Helios

Freshly Baked NYC's internal operations app, starting from the catalog curation workflow and expanding toward a consolidated tool surface.

## Stack

- React + Vite + TypeScript client
- Fastify + Node.js + TypeScript API
- TypeScript worker
- Postgres with raw SQL migrations

## Scripts

- `npm run dev`
- `npm run build`
- `npm run typecheck`
- `npm run db:migrate`
- `npm run user:provision -- --email you@freshlybaked.nyc --name "Your Name" --role admin`
- `npm run import:review -- /absolute/path/to/catalog_description_mass_update_review.json`
- `npm run smoke:workflow -- --catalog-group-id 12345 --user-email you@freshlybaked.nyc [--approval-field pricing|description] [--force-live-refresh]`

## Required Runtime Variables

- `DATABASE_URL` or `DATABASE_URL_FILE`
- `APP_BASE_URL`
- `SESSION_COOKIE_SECRET`

`APP_BASE_URL` must be the full mounted application URL, not just the origin. If Helios is mounted at `https://freshlybaked.nyc/internal/tools/helios`, set `APP_BASE_URL=https://freshlybaked.nyc/internal/tools/helios` so the server routes, static asset paths, cookies, and client router all agree on that base path.

For local loopback development, `APP_BASE_URL` should match the actual browser origin you are using for the Vite app. If local Google OAuth credentials still point at the production Freshly Baked callback, Helios now marks Google sign-in unavailable and exposes a localhost-only dev sign-in path for already-provisioned users instead of redirecting to a broken production callback.

Required before operators can sign in with Google:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`

For a deployment mounted at `/internal/tools/helios`, `GOOGLE_OAUTH_REDIRECT_URI` should be `https://freshlybaked.nyc/internal/tools/helios/api/auth/google/callback`.

If the Google OAuth variables are unset, the server will also try the standard Google client JSON secret at `/Users/amp-local/.secret/google-oauth/client` and the home-relative fallback `~/.secret/google-oauth/client`. It can extract `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and a single configured redirect URI from that JSON automatically. The legacy helper files at `/Users/amp-local/.secret/google-oauth/catalog-curation.env` and `catalog-curation-client-id` / `catalog-curation-client-secret` / `catalog-curation-redirect-uri` are still supported too.

`SESSION_COOKIE_SECRET` is not a Google-provided value. Generate a long random local secret for Helios, for example with `openssl rand -base64 32`, and provide it via `SESSION_COOKIE_SECRET` or `SESSION_COOKIE_SECRET_FILE`.

If `DATABASE_URL` is unset, the app will also try to auto-resolve the Postgres connection string from the local TigerData credentials material under `/Users/amp-local/.secret/tigerdata/`. If more than one credential file is present there, set `TIGERDATA_CREDENTIALS_FILE` to the exact file to use.

If `BEDROCK_MANTLE_BEARER_TOKEN` is unset, the worker will also try the documented local secret helpers at `/Users/amp-local/.secret/bedrock/mantle-bearer-token`, `~/.secret/bedrock/mantle-bearer-token`, and their `.env` helper variants.

If `SWEED_AUTH_TOKEN` is unset, the server and worker will also try `/Users/amp-local/.secret/sweed/auth-token`, `~/.secret/sweed/auth-token`, and their `.env` helper variants.

If `LITALERTS_BEARER_TOKEN` is unset, the worker will also try `/Users/amp-local/.secret/litalerts/bearer-token`, `~/.secret/litalerts/bearer-token`, and their `.env` helper variants.

Optional but expected soon:

- `APP_ALLOWED_ORIGINS`
- `BEDROCK_MANTLE_BASE_URL`
- `BEDROCK_MANTLE_BEARER_TOKEN` or `BEDROCK_MANTLE_BEARER_TOKEN_FILE`
- `GOOGLE_OAUTH_ALLOWED_DOMAIN`
- `LLM_REQUEST_TIMEOUT_MS`
- `PORT`
- `WORKER_POLL_INTERVAL_MS`
- `WORKER_MAX_CONCURRENT_JOBS`
- `SWEED_API_URL`
- `SWEED_STATE_DEALER_ID`
- `SWEED_AUTH_TOKEN` or `SWEED_AUTH_TOKEN_FILE`
- `LITALERTS_BEARER_TOKEN` or `LITALERTS_BEARER_TOKEN_FILE`
- `TIGERDATA_CREDENTIALS_FILE`

## First Boot

1. Run `npm install`.
2. Run `npm run db:migrate`.
3. Provision at least one active user row with `npm run user:provision`.
4. Import the current description review packet with `npm run import:review -- /absolute/path/to/catalog_description_mass_update_review.json`.
5. Start the app with `npm run dev`.

## Workflow Smoke Runner

`npm run smoke:workflow` is a local validation harness for the already-imported TigerData dataset. It:

- signs a local session cookie for an existing provisioned admin user
- drives the Fastify API in-process
- pumps worker jobs directly until they settle
- exercises description batch generation, pricing batch generation, approve, reconcile, undo, description rerun, and full-summary refresh for one chosen catalog group

The script requires a real provisioned admin user row and the normal runtime credentials for the flows it exercises. It is a local operator/developer utility, not a production auth bypass.
