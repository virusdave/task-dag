# Helios signed-agent readonly allowlists

Helios can accept short-lived, Ed25519-signed `GET`/`HEAD` requests from local
agents when `HELIOS_AGENT_READONLY_PUBLIC_KEYS_JSON` and an expiring
`HELIOS_AGENT_READONLY_ALLOWLIST_JSON` or `HELIOS_AGENT_READONLY_ALLOWLIST_PATH`
are configured. This is an explicit safe-read bypass of the normal anonymous
session gate, not a general login mechanism.

Use this guide before adding a path to the allowlist. The default answer is
"no" until the route author has proved the page and every request it triggers
is safe for signed-agent readonly access.

## What the allowlist does and does not do

- It authenticates a request as a signed readonly agent and then lets it reach
  the normal route handler. Route-level RBAC still applies. A route that calls
  `requireSessionUser(request, reply, 'admin')` will still reject the synthetic
  signed-agent viewer unless that route is separately changed and reviewed to
  admit signed-agent reads.
- It is method- and path-specific. Only `GET` and `HEAD` are supported.
- It is not transitive. A page entry such as `/config/agent-waste` does not
  imply access to `/api/session`, `/api/agent-waste/backlog`, `/assets/...`, or
  any loader/API route the SPA calls after the HTML shell loads. Each required
  route needs its own safe-read entry.
- Prefix matches are intentionally limited to static asset routes. Page and API
  routes need exact entries so route authors review each surface explicitly.
- The response byte cap is enforced after the handler runs. It prevents an
  oversized response from being returned to the agent, but it does not make an
  expensive or PII-heavy route safe.
- Helios config stores verifier public keys only. Private signing keys never
  belong in Helios config, deployment env files, agenix secrets, examples, or
  allowlist JSON.

## Route-author safe-read checklist

Only add a `GET` route when every item below is true and captured in the
route-specific `safe_read_note`.

1. **No hidden writes behind `GET`.** The handler must not mutate DB rows,
   sessions, cookies, git repos, files, job state, cache state, audit queues, or
   external systems. Watch for helper calls that look like reads but perform
   refresh-on-miss, upserts, last-seen updates, or lazy initialization.
2. **No cache or external refresh side effects.** A safe-read route may read a
   warm local cache. It must not trigger Sweed RPCs, Bedrock calls, Google API
   calls, site crawls, git fetch/pull, artifact publication, or any refresh
   that changes durable state or costs money. If freshness requires a refresh,
   keep the route out of the signed-agent allowlist and use an authenticated
   operator session instead.
3. **Bounded cost.** The route must have predictable work and response size:
   indexed lookups, bounded limits, or small committed/static files. Do not
   allowlist full-table scans, unbounded joins, broad search endpoints, report
   exports, on-demand model calls, or routes whose cost scales with all
   historical data.
4. **No streaming, SSE, or downloads.** Do not allowlist routes that return
   streams, server-sent events, long polls, ZIP/CSV/PDF/download payloads, or
   generated bundles. The auth gate rejects stream payloads for signed agents,
   but route authors should keep those paths out of config entirely.
5. **PII is minimal and necessary.** Avoid PII-heavy pages and APIs by default:
   customer profiles, order histories, addresses, phone/email lists, staff HR
   details, raw review submissions, and free-text operational notes. If a route
   contains any PII, the `safe_read_note` must name the fields and explain why a
   signed local agent needs them.
6. **SPA dependencies are enumerated.** For a page route, list the HTML shell,
   `/api/session`, every React loader/fetch the page performs, and static asset
   prefixes. Page rules do not imply API rules.
7. **Route-level auth is still correct.** If the target API uses a stricter
   role than `viewer`, either leave it inaccessible to signed agents or make a
   small route-local change that explicitly admits `request.agentReadonlyPrincipal`
   for the reviewed readonly path only. Never weaken a route's normal session
   role requirement just to satisfy signed-agent access.
8. **Byte cap is intentionally small.** Set `max_response_bytes` to the smallest
   value that covers expected JSON or HTML plus normal variance. Keep it below
   the global `HELIOS_AGENT_READONLY_MAX_RESPONSE_BYTES`; raising the cap is not
   a substitute for bounding the route.
9. **Expiry is short.** Use a narrow `not_before`/`not_after` window tied to the
   review or rollout. Long-lived allowlists become unattended credentials.

## Suggested `safe_read_note` shape

Write notes for future reviewers, not for the signer. Good notes name the
handler, its source of data, its bounds, and why there are no side effects:

```json
{
  "method": "GET",
  "kind": "api",
  "match": "exact",
  "path": "/api/example/status",
  "safe_read_note": "routes/exampleStatus.ts reads one cached status object; no DB writes, external refreshes, streams, downloads, or PII; expected body <16 KiB."
}
```

Weak notes such as `"readonly"`, `"needed by page"`, or `"GET route"` are not
enough. The code already says the method is `GET`; the note must explain why
this specific `GET` is safe.

## Inactive example: `/config/agent-waste` review page

This is an example-only snippet for route authors. Do not paste it into
production unchanged: the dates are intentionally expired, the public key is a
placeholder, and the agent-waste backlog API currently remains admin-gated by
`requireSessionUser(..., 'admin')`. The example shows the dependency inventory
that must be reviewed if that page ever becomes signed-agent-readable:

- the page shell (`/config/agent-waste`),
- the root/session loader (`/api/session`),
- the page's data API (`/api/agent-waste/backlog`; the current page has no
  React Router loader, but it fetches this API after mount), and
- the static Vite bundle assets (`/assets/`).

```json
{
  "public_keys": [
    {
      "id": "example-agent-key-2026q3",
      "public_key": "REPLACE_WITH_32_BYTE_ED25519_PUBLIC_KEY_BASE64URL"
    }
  ],
  "allowlist": [
    {
      "id": "example-agent-waste-review-readonly-2026-01-01",
      "owner": "route-author@example",
      "reason": "EXAMPLE ONLY: document the /config/agent-waste signed-agent dependency set.",
      "not_before": "2026-01-01T00:00:00Z",
      "not_after": "2026-01-02T00:00:00Z",
      "max_response_bytes": 1048576,
      "paths": [
        {
          "method": "GET",
          "kind": "page",
          "match": "exact",
          "path": "/config/agent-waste",
          "safe_read_note": "SPA history fallback returns index.html only; no route handler side effects. Page access alone does not grant its APIs."
        },
        {
          "method": "GET",
          "kind": "session",
          "match": "exact",
          "path": "/api/session",
          "safe_read_note": "Synthetic signed-agent session envelope only: viewer permissions, no DB user lookup, no pending-migration DB check for agent requests, no cookies set."
        },
        {
          "method": "GET",
          "kind": "api",
          "match": "exact",
          "path": "/api/agent-waste/backlog",
          "safe_read_note": "EXAMPLE ONLY unless route-level auth is deliberately changed: reads the mirrored agent-waste backlog from the configured local repo path, validates rows, and returns the pending observations; no promote, cluster, model call, git write, or advisory injection. Review PII/free-text notes and expected backlog size before enabling."
        },
        {
          "method": "GET",
          "kind": "asset",
          "match": "prefix",
          "path": "/assets/",
          "safe_read_note": "Vite hashed static assets under dist/client/assets only; prefix is allowed because the server resolves paths under the assets directory and returns immutable files or a no-store stale-bundle recovery module."
        }
      ]
    }
  ]
}
```

Operational config uses two separate env values, not the wrapper object above:

- `HELIOS_AGENT_READONLY_PUBLIC_KEYS_JSON` receives the `public_keys` array (or
  an object map of key id to public key).
- `HELIOS_AGENT_READONLY_ALLOWLIST_JSON` or `HELIOS_AGENT_READONLY_ALLOWLIST_PATH`
  receives the `allowlist` array (or a single rule object).

Again: publish only public verifier keys to Helios. The private Ed25519 signing
key stays with the caller that creates signed requests.
