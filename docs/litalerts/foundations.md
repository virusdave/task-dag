# Lit Alerts Foundations

Load this first when you need the basic Lit Alerts request conventions and auth behavior.

Source: `HOW_LITALERTS_WORKS.md`

## API Shape

The Lit Alerts UI currently talks to a JSON HTTP API rooted at `https://public-api.litalerts.com/`.

Observed requests so far were standard `POST` requests with JSON bodies rather than RPC envelopes.

Example endpoints captured in this workspace:

- `POST /Products/menulistings`
- `POST /Dispensaries/alllocations`
- `POST /filters/new`
- `GET /Manufacturers/real`

Observed frontend headers from the HARs:

- `authorization: Bearer <jwt>`
- `content-type: application/json; charset=utf-8`
- `origin: https://brands.litalerts.com`
- `referer: https://brands.litalerts.com/`

Practical implication:

- The backend is currently easy to replay from HAR-derived requests as long as the session bearer token is still valid.
- We are intentionally treating this as a UI-backed integration for now, not a stable public partner API contract.

## Authentication

- The Lit Alerts backend used a bearer token from the `brands.litalerts.com` session.
- The token was sent in the `Authorization` header, not in cookies or the JSON body.
- In this workspace, the token captured on 2026-04-12 was still usable for immediate follow-up replays against the same endpoints.
- By 2026-04-28, the older bearer JWTs preserved in repo HARs from 2026-04-12 and 2026-04-13 were no longer accepted by `public-api.litalerts.com`; replay checks against `GET /Manufacturers/real?page=0&pagesize=1&state=NY` returned `401` for every token found in those captures.
- On 2026-04-27, a newer HAR at `automation/bulk_additions/brands.litalerts.com_Dispensaries_alllocations_Archive [26-04-27 20-17-09].har` did contain a fresh usable bearer token. Replaying its captured `POST /Dispensaries/alllocations` request against `https://public-api.litalerts.com/Dispensaries/alllocations` returned `200`, and the same token continued to return `200` after being installed into local secret storage at `/Users/amp-local/.secret/litalerts/bearer-token`.
- On 2026-04-29, a live HAR at `/tmp/brands.litalerts.com_Tenants_allstates_Archive [26-04-29 11-48-01].har` also contained a usable bearer token in the captured `Authorization` header. Replaying `GET https://public-api.litalerts.com/Manufacturers/real?page=0&pagesize=1&state=NY` with that token returned `200`, and writing it into `/Users/amp-local/.secret/litalerts/bearer-token` restored the live statewide sourcing workflow immediately.
- On 2026-04-30, a narrower HAR at `/tmp/brands.litalerts.com__Archive [26-04-30 18-08-53].har` showed the underlying refresh path instead of a direct Lit Alerts API call. `brands.litalerts.com` called `POST https://cognito-idp.us-east-2.amazonaws.com/` with `Content-Type: application/x-amz-json-1.1`, `x-amz-target: AWSCognitoIdentityProviderService.GetTokensFromRefreshToken`, and a JSON body containing the observed Cognito app `ClientId` plus the current encrypted `RefreshToken`.
- That refresh call returned `AuthenticationResult.AccessToken`, `AuthenticationResult.IdToken`, `AuthenticationResult.TokenType`, and `AuthenticationResult.ExpiresIn`. The observed response had `TokenType: Bearer` and `ExpiresIn: 86400`.
- Replaying `GET https://public-api.litalerts.com/Manufacturers/real?page=0&pagesize=1&state=NY` with the newly returned `AuthenticationResult.AccessToken` from that Cognito refresh response returned `200`, confirming that this Cognito-minted access token is the bearer credential accepted by `public-api.litalerts.com`.

### Observed Cognito Refresh Shape

Observed request characteristics from the 2026-04-30 HAR:

- Endpoint: `POST https://cognito-idp.us-east-2.amazonaws.com/`
- Header `x-amz-target`: `AWSCognitoIdentityProviderService.GetTokensFromRefreshToken`
- Header `content-type`: `application/x-amz-json-1.1`
- Header `x-amz-user-agent`: `aws-amplify/6.16.4 framework/0`
- Request body shape: `{ "ClientId": "<cognito app client id>", "RefreshToken": "<encrypted refresh token>" }`

Observed response characteristics:

- Response body key: `AuthenticationResult`
- Returned fields: `AccessToken`, `IdToken`, `TokenType`, `ExpiresIn`
- No new refresh token was observed in that response body; the refresh path appears to mint fresh access/id tokens from the existing refresh token.

Practical implication:

- Treat the bearer token as session-bound and ephemeral.
- Do not assume an old token will remain valid indefinitely.
- When automating from HARs, prefer extracting the current token from the newest capture instead of hardcoding it separately.
- A successful token refresh does not depend on a specific Lit Alerts endpoint family; any fresh `brands.litalerts.com` HAR that captured a valid `Authorization: Bearer ...` header can be a usable recovery source.
- If the newest HAR only captured the Cognito refresh call, that is still enough to recover: extract the refreshed `AuthenticationResult.AccessToken` from the HAR response or replay the same refresh request with the still-valid refresh token, then validate it against a lightweight public-api request.
- Only the access token is needed for Lit Alerts API reads. Keep the refresh token and Cognito client details in local secret material or short-lived debug context, never in repo docs, generated artifacts, or committed scripts.
- If all repo-captured HAR tokens are returning `401`, stop retrying stale captures and refresh `LITALERTS_BEARER_TOKEN` from a new live `brands.litalerts.com` session or local secret material.
- For local Helios runtime setup, validate the freshly extracted token with a lightweight live request before claiming Lit Alerts is configured, then write it into the auto-discovered secret path instead of baking it into repo files or long-lived shell history.

### Cognito Refresh Path Migration

Observed across 2026-05-05 and 2026-05-07 in this workspace:

- The bearer token at `/Users/amp-local/.secret/litalerts/bearer-token` expires on a roughly 24-hour cadence (`AuthenticationResult.ExpiresIn: 86400`) and silently begins returning `401` from `public-api.litalerts.com` once the access token has aged out. Treat any pending-purchase, pricing-ladder, or competitor-evidence task that relies on Lit Alerts as needing a fresh refresh-or-recapture step before it can run.
- The legacy refresh path used by older repo scripts is `POST cognito-idp.us-east-2.amazonaws.com/` with `x-amz-target: AWSCognitoIdentityProviderService.InitiateAuth` and body `{ "AuthFlow": "REFRESH_TOKEN_AUTH", "ClientId": "...", "AuthParameters": { "REFRESH_TOKEN": "..." } }`. This now returns `HTTP 400 Bad Request` against the current Cognito user pool even when the refresh token itself is unchanged.
- The current working path is the same Cognito host with `x-amz-target: AWSCognitoIdentityProviderService.GetTokensFromRefreshToken` and a flat body `{ "ClientId": "...", "RefreshToken": "..." }`. It returns the standard `AuthenticationResult.{AccessToken, IdToken, TokenType, ExpiresIn}` envelope and the resulting `AccessToken` is what `public-api.litalerts.com` accepts as the bearer.
- The refresh token shape AWS Amplify writes into `brands.litalerts.com` storage also changed when the SDK migrated to `GetTokensFromRefreshToken`. A refresh token captured in an older HAR (for example the 2026-04-12 archive in this workspace) is no longer accepted even by the new endpoint, so the recovery path needs a HAR captured after the SDK upgrade rather than a textually-extracted older `refreshToken=...;` cookie value.
- Known repo script still on the broken envelope: [`bulk_additions/2026-04-10/generate_prerolls_pricing_catalog_proposal.py`](../../bulk_additions/2026-04-10/generate_prerolls_pricing_catalog_proposal.py) `refreshed_litalerts_access_token()`. Other Lit Alerts-using scripts that import `provider_headers_from_entry` from that module inherit the same failure mode. When updating these, switch the `x-amz-target` and the body shape together; do not leave the old envelope in place as a fallback.

### Automated Refresh Script (Preferred Recovery Path)

As of 2026-05-11 the workspace ships a turnkey refresher at
[`litalerts/refresh_bearer_token.py`](../../litalerts/refresh_bearer_token.py)
that encapsulates the `GetTokensFromRefreshToken` call so an agent does not
have to re-page the operator for each ~24h Cognito access-token rotation.

Inputs the script reads (both must exist with mode `0600`):

- `/Users/amp-local/.secret/litalerts/refresh-token` - long-lived Cognito
  refresh token captured from a `brands.litalerts.com` HAR after the AWS
  Amplify SDK upgrade. The 2026-05-11 capture
  (`/tmp/brands.litalerts.com__Archive [26-05-11 18-37-00].har`) is the
  canonical reference shape: a single `POST cognito-idp.us-east-2.amazonaws.com/`
  request whose body is `{ "ClientId": "696jmvfc56kqe1bb38j55er8in",
  "RefreshToken": "<encrypted refresh jwt>" }`.

Outputs the script writes:

- `/Users/amp-local/.secret/litalerts/bearer-token` - the freshly minted
  `AuthenticationResult.AccessToken` (mode `0600`).

Behavior:

- Forces IPv4 for the Cognito + LitAlerts hosts to dodge the workspace's
  intermittent Cloudflare IPv6 challenge.
- Sends `Content-Type: application/x-amz-json-1.1`,
  `X-Amz-Target: AWSCognitoIdentityProviderService.GetTokensFromRefreshToken`,
  and `X-Amz-User-Agent: aws-amplify/6.16.4 framework/0`.
- After Cognito returns `AccessToken`, validates it against
  `GET /Manufacturers/real?page=0&pagesize=1&state=NY` before persisting it,
  so a "refresh succeeded but the token is rejected" failure surfaces loudly
  rather than getting written to disk and then exploding mid-packet.
- Exits non-zero on any failure (Cognito HTTP error, missing
  `AuthenticationResult`, LitAlerts verification HTTP error). No silent
  failure mode.

Operational rule: when a Lit Alerts-backed task gets a `401`, run
`python3 automation/litalerts/refresh_bearer_token.py` first. Only escalate
to the operator when the script itself fails (for example, the saved
refresh token has been revoked and Cognito returns
`NotAuthorizedException: Invalid Refresh Token`). When that happens, the
operator must capture a fresh `brands.litalerts.com` HAR (any session that
triggers a Cognito `GetTokensFromRefreshToken` call), drop it somewhere the
agent can read, and the agent will replace the saved
`/Users/amp-local/.secret/litalerts/refresh-token` from the new HAR before
re-running the refresher.

### Manual Recovery Checklist (Fallback)

When the automated path is unavailable:

1. Probe the secret bearer with `GET https://public-api.litalerts.com/Manufacturers/real?page=0&pagesize=1&state=NY` and treat `401` as "token aged out".
2. If a fresh `brands.litalerts.com` HAR exists, replay its `GetTokensFromRefreshToken` call (or copy the captured `AuthenticationResult.AccessToken`) and write the result into `/Users/amp-local/.secret/litalerts/bearer-token` with mode `0600`.
3. If no fresh HAR exists and no other script in the workspace can mint a working access token via `GetTokensFromRefreshToken`, stop and page the operator. Do not silently fall back to public menu pages or swallow Lit Alerts evidence from the output, because downstream review packets advertise their pricing ladder as Lit Alerts-backed.
