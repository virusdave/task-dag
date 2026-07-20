# Helios signed-agent capability overlays

**Issue:** [FreshlyBakedNYC/automation#87](https://github.com/FreshlyBakedNYC/automation/issues/87)  
**Prior clustering proposal:** [virusdave/top-level#74](https://github.com/virusdave/top-level/issues/74)  
**Status:** resolved implementation contract

This design adds a short-lived, operator-approved way for a local agent to
invoke one specifically reviewed Helios action. It is not a general agent
login, a synthetic admin, or an extension of the existing
[signed-agent readonly allowlist](./signed-agent-readonly-allowlists.md).
Readonly behavior and headers remain unchanged.

The first action is the display-only Agent Waste clustering request. The
operator-approved verification sequence is:

1. a signed agent invokes clustering;
2. **Remove from cluster** changes the returned snapshot in browser memory;
3. **Undo** restores that browser-memory snapshot.

Steps 2 and 3 are not RPCs and create no durable state. This design does not
invent persisted Remove or Undo endpoints for a test. A future persisted
operation needs a new versioned action specification and a newly approved
overlay shape.

## Security and trust boundaries

There are three separate principals and two separate Ed25519 key scopes:

- `session`: the existing OAuth/session user. Only an authenticated active
  admin session can create or revoke an overlay.
- `agent_readonly`: the existing synthetic viewer. It still accepts only
  `GET`/`HEAD`, retains its existing headers/configuration and response cap,
  and never gains capability actions.
- `agent_capability`: a new request-local principal. It has no role, session
  envelope, navigation permission, or ambient access. It is useful only when
  a route calls the route-local capability guard for the exact action.
- **Agent request keys** sign invocation payloads. Their public keys are in a
  new capability-only keyring (`HELIOS_AGENT_CAPABILITY_PUBLIC_KEYS_JSON`),
  separate from the readonly keyring, and each overlay names the exact
  permitted key IDs. There is no implicit key reuse. They cannot approve
  overlays.
- **Overlay attestation key** signs only the domain-separated canonical
  overlay artifact after an admin creates it. Its private key is available
  only to Helios server code and never signs requests. Its public key verifies
  artifacts on every load. Rotating this key revokes artifacts signed by the
  retired key unless the old verifier is deliberately retained.

Neither private key may enter browser JavaScript, an API response, a Vite
environment variable, repository content, logs, or an overlay artifact. The
agent's private request key remains in the local agent credential store; the
overlay attestation private key is an agenix-provisioned server secret.

An overlay cannot grant access to the create, revoke, emergency-revoke,
session, or auth endpoints: those endpoints are not capability actions and
the registry rejects any specification whose path is in those namespaces.
The overlay administration routes always require a real admin session and
normal origin validation. An `agent_capability` or `agent_readonly` principal
is rejected before any artifact write.

## Versioned action registry

Code owns a closed registry of reviewed action specifications. Configuration
can turn a registered action on or off; it cannot add a path, loosen a body
schema, or reinterpret an old action ID. Each behavior change gets a new ID.
The initial registry entry is:

| Field | `agent-waste.cluster.v1` |
| --- | --- |
| Method | `POST` |
| Canonical app-relative path | `/api/agent-waste/clusters` (exact) |
| Query policy | no query string, including a bare `?` |
| Content type | exactly `application/json` after lowercasing the media type; parameters are rejected |
| Body limit | 4,096 raw bytes, enforced by Fastify before parsing |
| Parsed schema | the existing strict `AgentWasteClustersRequestSchema`, currently exactly `{}` |
| Semantic body | RFC 8785/JCS encoding of the schema-parsed value: `{}` |
| Body digest | lowercase hex `SHA-256(semantic body UTF-8 bytes)` |
| Side effects | reads the current backlog and may spend bounded model inference; no DB, git, backlog, or browser-state write |
| Retry class | analysis-only/idempotent: duplicate execution may repeat bounded inference but cannot duplicate durable state |

Each registry entry exposes `spec_sha256`, the lowercase SHA-256 of its JCS
descriptor (ID, method, path, query/content-type policies, body schema version,
body limit, and retry class). An overlay stores both the action ID and this
digest. A code deployment that changes the descriptor invalidates old grants
instead of silently expanding them.

The exact initial descriptor golden vector is:

```json
{"action_id":"agent-waste.cluster.v1","body_limit_bytes":4096,"body_schema":"strict-empty-object-v1","content_type":"application/json","method":"POST","path":"/api/agent-waste/clusters","query_policy":"none","retry_class":"analysis-idempotent-v1"}
```

Its `spec_sha256` is
`0090c31b5f120efb18e4564b6fe94569e1618ce223ce4c6a7331afeff0760a5e`.
The semantic-body bytes are `{}` and their SHA-256 is
`44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`.
Tests must pin these values rather than recomputing both sides with the same
possibly-wrong serializer.

Future actions that write durable state must declare a route-owned durable
idempotency strategy before entering the registry (for example a unique DB key
or immutable git operation ID). The generic capability layer does not pretend
nonce replay prevention makes an action's side effects exactly-once.

## Immutable overlay and approval binding

The admin UI displays and the operator approves a strict intent containing
`actionIds`, `agentKeyIds`, optional `notBefore`, and optional `ttlSeconds`.
Submitting that intent through
`POST /api/config/signed-agent-capability-overlays` is the operator approval
event. The server derives actor identity, `grant_id`, `issued_at`, final expiry,
request ID, expanded action descriptors, and shape digest. It returns and the
UI displays the complete resulting shape and digest. Client-supplied approval
identity, grant ID, `expires_at`, spec digest, or descriptor is never accepted.

The create body is strict JSON
`{actionIds: string[1..32], agentKeyIds: string[1..32], notBefore?: RFC3339,
ttlSeconds?: integer}` with unique IDs; omitted TTL is 14,400 seconds and the
maximum is 1,209,600 seconds. `notBefore` may not precede server time or be
more than 14 days ahead. Individual revoke is strict
`DELETE /api/config/signed-agent-capability-overlays/:grantId` with no body or
query. Emergency disable and re-enable are strict empty-body `POST`s to
`/api/config/signed-agent-capability-overlays/emergency-disable` and
`.../emergency-enable`. All four are admin-session-only, origin-checked, and
emit actor/digest audit events.

The canonical `shape` is JCS-encoded and contains only:

```json
{
  "version": 1,
  "grant_id": "019f7f00-0000-7000-8000-000000000001",
  "issued_at": "2026-07-20T12:00:00.000Z",
  "not_before": "2026-07-20T12:00:00.000Z",
  "expires_at": "2026-07-20T16:00:00.000Z",
  "approved_by": { "user_id": 123, "email": "operator@example.com" },
  "approval_request_id": "req-golden-1",
  "actions": [
    {
      "action_id": "agent-waste.cluster.v1",
      "spec_sha256": "0090c31b5f120efb18e4564b6fe94569e1618ce223ce4c6a7331afeff0760a5e",
      "agent_key_ids": ["local-worker-2026q3"]
    }
  ]
}
```

Object keys use JCS ordering; action rows and key IDs are unique and sorted
lexicographically before canonicalization. Unknown fields are rejected. Times
are UTC RFC 3339 with exactly three fractional digits. `issued_at` and the
default `not_before` come from server time. Omitted TTL means four hours.
Requested TTL must be positive and at most 14 days from `not_before`; expiry
cannot be extended or shape fields edited in place. A different selection or
expiry is a new approval and new `grant_id`.

The immutable envelope is:

```json
{
  "shape": {
    "version": 1,
    "grant_id": "019f7f00-0000-7000-8000-000000000001",
    "issued_at": "2026-07-20T12:00:00.000Z",
    "not_before": "2026-07-20T12:00:00.000Z",
    "expires_at": "2026-07-20T16:00:00.000Z",
    "approved_by": { "user_id": 123, "email": "operator@example.com" },
    "approval_request_id": "req-golden-1",
    "actions": [{
      "action_id": "agent-waste.cluster.v1",
      "spec_sha256": "0090c31b5f120efb18e4564b6fe94569e1618ce223ce4c6a7331afeff0760a5e",
      "agent_key_ids": ["local-worker-2026q3"]
    }]
  },
  "shape_sha256": "SHA-256(JCS(shape))",
  "attestation_key_id": "helios-overlay-approval-2026q3",
  "attestation": "base64url Ed25519 signature"
}
```

The signature input is the UTF-8 string
`helios-agent-capability-overlay-v1\n<shape_sha256>`. The server inserts the
envelope once under its exact reserved grant key; a primary-key conflict fails
rather than updating approval state. Thus the artifact binds immutable approval
provenance to the exact endpoint/action/key/TTL shape. The create response may
return the public envelope and digest but never either private key.

For the displayed example with grant ID
`019f7f00-0000-7000-8000-000000000001`, request ID `req-golden-1`, and the
initial descriptor digest above, JCS(shape) has SHA-256
`2bce8142979ae6db9a817f9931908b272780aa13c3ed64f680b85ae14b2055a2`.
The golden fixture uses test-only 32-byte Ed25519 private seeds `01` repeated
32 times for attestation and `02` repeated 32 times for the agent. Their raw
base64url public keys are respectively
`iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w` and
`gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q`. The exact attestation input
(no terminal newline) produces signature
`UY962bfTr3dsLKQViY-y41fleaXgsir4qXdAYg-HcBD21UzNrt1j4KZ5YPojs_5-Jmi3x3FIxbOFvTqfehMFCQ`.
These keys and signatures are test vectors, never valid configuration or
deployment examples.

## Admission and request signature

Capability requests use their own complete header family; mixing any session
cookie, `Authorization`, readonly-agent header, duplicate header, or capability
header family fails closed:

- `x-helios-agent-capability-key-id`
- `x-helios-agent-capability-grant-id`
- `x-helios-agent-capability-action-id`
- `x-helios-agent-capability-timestamp`
- `x-helios-agent-capability-nonce`
- `x-helios-agent-capability-idempotency-key`
- `x-helios-agent-capability-body-sha256`
- `x-helios-agent-capability-signature`

One credential classifier runs before either agent verifier. Presence of any
capability header selects capability verification; any readonly header selects
readonly verification; presence of both families, or either family with a
Cookie/Bearer credential, is rejected. Fastify's raw header pairs are checked
so coalescing cannot hide duplicates.

The Ed25519 request signature covers this exact UTF-8 payload:

```text
helios-agent-capability-request-v1
method:POST
host:helios.freshlybaked.us
path:/api/agent-waste/clusters
query:
content_type:application/json
body_sha256:<64-lowercase-hex>
key_id:<key-id>
grant_id:<grant-id>
action_id:agent-waste.cluster.v1
timestamp:<exact-header-value>
nonce:<base64url-random-value>
idempotency_key:<safe-token>
```

The exact golden request payload is:

```text
helios-agent-capability-request-v1
method:POST
host:helios.freshlybaked.us
path:/api/agent-waste/clusters
query:
content_type:application/json
body_sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
key_id:local-worker-2026q3
grant_id:019f7f00-0000-7000-8000-000000000001
action_id:agent-waste.cluster.v1
timestamp:2026-07-20T12:01:00.000Z
nonce:AAAAAAAAAAAAAAAAAAAAAA
idempotency_key:cluster-golden-1
```

Joining those 13 lines with one LF between lines and **no terminal LF**
produces the agent-key signature
`4dfRK1tRkR4yX8qXSW934N20UqkU9QLyDkVo_mGx69JfWKlSh2z_EGbMYYa3Y0ChpKo2GRGBdydYxlQicAuhDQ`.

Host is lowercase and path/query must round-trip through URL parsing without
encoded separators, backslashes, control characters, fragments, dot-segment
normalization, or ambiguous percent encoding. The app base path is removed in
the same way as readonly verification. Host is the normalized HTTP `Host`
header, including an explicit port when present; production signatures use
`helios.freshlybaked.us`. Timestamp syntax is exactly RFC 3339 UTC with three
fractional digits. Key/grant/action/idempotency tokens are 1–128 characters
from `[A-Za-z0-9._:-]`; nonce is 22–256 unpadded base64url characters and at
least 128 random bits; signatures are unpadded base64url encodings of exactly
64 bytes. The signature timestamp must be within 90 seconds of server time.

Admission happens in two stages, both before the action's first expensive or
durable side effect:

1. `onRequest` recognizes only the capability header family; validates mixed
   credentials, method/host/path/query/content type, request signature, grant
   attestation, current server time, key/action/spec membership, revocation,
   timestamp and nonce; then attaches a pending `agent_capability` principal.
   It does not synthesize a session user. The normal origin hook exempts only
   this successfully verified principal.
2. After Fastify parses the bounded body, the route parses its strict action
   schema and calls `requireAgentCapability(request, reply,
   'agent-waste.cluster.v1', parsedBody)`. The guard canonicalizes the parsed
   semantic body, compares the digest in constant time, consumes the nonce,
   applies the action's retry rule, and marks authorization accepted. The
   clustering route explicitly branches: an active admin session follows its
   current authorization, otherwise it requires this exact capability. It
   parses `request.body` directly and requires the literal object `{}`;
   missing and `null` bodies are not changed to `{}`. Every other route keeps
   its existing guard, so a route that only calls `requireSessionUser` rejects
   capability requests.

Nonce registry keys are SHA-256 hashes of `(agent key ID, nonce)` with a
three-minute TTL and one shared 128-entry capacity across both mirrors. The
final guard atomically consumes a nonce only after signature and semantic body
validation, preventing both races and unauthenticated registry poisoning. At
capacity it prunes expired entries and then fails closed; it never evicts a
live nonce.
Immediately before consuming it, the guard rechecks server time, activation,
expiry, emergency/individual revocation, current spec digest, and key/action
membership. The idempotency key is signed and included in audit. For v1 a
retry uses a fresh nonce and the same idempotency key and may recompute. The
online server does not claim to recognize it as a retry: every accepted v1
outcome records `executionDisposition: 'recomputed'`; repeated idempotency keys
may be correlated offline. Any future durable mutation is inadmissible until its
registry entry supplies cross-process durable idempotency.

## Reload, expiry, and revocation

Capability state is stored in the existing PostgreSQL `public.app_settings`
table, so both hot mirrors observe the same grants, emergency state, and nonce
registry. There is no host-local overlay directory. The reserved keys are
`signed_agent_capability_grant:<UUID>`,
`signed_agent_capability_emergency_disabled`, and
`signed_agent_capability_nonce_registry`; other settings are never scanned.

Each grant is one immutable, insert-only JSONB row and is deleted on revoke.
The emergency row's presence disables admission even when its value is
malformed. Every mutation and nonce finalization takes the same transaction
advisory lock (`helios:signed-agent-capability-state:v1`), linearizing create,
revoke, disable, and action start across mirrors. Admission performs two exact
primary-key reads without caching, polling, or LISTEN.

Signed envelopes are bounded to 16 KiB UTF-8 on both write and read; SQL uses
`pg_column_size` plus `CASE` so oversized JSONB is never returned to the
process. The shared registry stores SHA-256 hashes only, has a three-minute
TTL, prunes expired entries during finalization, and fails closed at 128 live
entries or if malformed. This adds two indexed reads per capability admission
and, at finalization, one short serialized transaction with exact-key reads and
one small JSONB write; ordinary OAuth and readonly-agent traffic does no such
work. Rollback is code-only: deploy the prior version after first draining or
revoking grants; the reserved rows may then be deleted administratively.

Every request uses server time to enforce `not_before <= now < expires_at`;
caller time cannot keep a grant alive. Revocation deletes the exact grant row
through the admin-only revoke route. Emergency revocation creates the reserved
emergency row, which denies every capability request and grant creation while
leaving OAuth and readonly requests intact. Removing that row requires a fresh
authenticated operator action; it does
not resurrect expired or individually revoked grants.

Malformed, oversized, unverifiable, stale-spec, unknown-key, inactive, or
revoked rows are denied. A bad grant row does not disable other valid grants.
Store unavailability returns `state_unavailable` (HTTP 503) only for requests
carrying capability headers; invalid global verifier configuration disables
capabilities without affecting ordinary sessions or readonly access.

## Audit and failure behavior

Each attempt emits one structured authorization record with request ID, outcome,
reason code, remote address, key/grant/action IDs, shape/spec digests,
timestamp, nonce hash (not raw nonce), idempotency key, method/path, body
digest, and overlay approval identity/time/expiry when known. It never logs
request or response bodies, notes, cookies, signatures, or private material.

`onRequest` records pending/denied state but never calls a request accepted
until the body-bound final guard succeeds; the completion hook emits that one
final authorization event. The route emits a second outcome record correlated by request ID containing
`started`, final HTTP status, duration, execution disposition, and the
action's safe summary (for clustering: observation count, deterministic
cluster count, refined batch successes/failures, and completeness). A denied
request emits no action-start record. Handler failure is distinguishable from
authorization denial. Audit logging failure is loud in server logs but does
not turn a completed analysis response into an unsafe retry; future durable
actions must include their outcome in the same durable transaction or
idempotency record.

Authorization errors return a flat `401` for malformed signature credentials
and `403` for well-formed but ungranted/inactive/revoked shape. They do not
reveal whether another key, grant, or action exists. Body size remains `413`,
body/schema mismatch `400`, and dependency/model availability uses the
route's structured status. A failure loading one overlay or refining one
cluster batch never corrupts global auth state or discards independently
useful clustering output.

## Operator-facing clustering contract

The current all-or-nothing model batching is intentionally replaced. This is
an operator-assistance surface: reliably returning useful, visibly partial
work is better than throwing away the baseline because one stochastic model
batch failed. This is a deliberate availability/UX tradeoff, not accidental
omission of error handling.

The committed spike evaluates `clusterfck` and `figue` against one
representative fixture as requested in
[top-level#74](https://github.com/virusdave/top-level/issues/74). The design
already rejects their current npm names: as checked 2026-07-20, `clusterfck`
is an npm deprecation-holder package and `figue` is now an unrelated
configuration library; neither may become a production dependency. The
baseline is therefore a small in-repo deterministic implementation:

1. Assign every input its occurrence identity: JCS(observation) plus its
   zero-based source position, so byte-identical events remain distinct.
2. Normalize `kind`, `id`, `repo`, and `note` with NFKC + lowercase, split on
   non-ASCII-alphanumeric boundaries and letter/digit transitions, and remove
   a committed fixed English stopword set. Build a set (not term frequency).
3. Build candidate pairs through a token-to-occurrence inverted index. Pair
   similarity is Jaccard intersection/union. Join a pair when normalized
   `kind\0id` is equal, or similarity is at least 0.60 with at least three
   shared tokens. Connected components form baseline clusters; singletons
   remain unclustered. No random seed exists.
4. Label from the lexicographically smallest normalized `kind:id`; choose the
   primary by greatest `(wasted tokens, wasted seconds)`, then occurrence
   identity. Sort clusters by aggregate tokens, aggregate seconds, count,
   label by explicit UTF-16 code-unit comparison, then smallest occurrence
   identity. The committed fixture is the golden contract for normalization,
   threshold edges, duplicate occurrences, labels, and total ordering.

This deterministic full-backlog baseline has stable ordering and exactly-once
observation coverage. Refinement units are produced by walking baseline
connected components in final deterministic order and packing whole components
sequentially up to `CLUSTER_BATCH_SIZE` (200 observations); singletons are
eligible. A component larger than 200 is never split: it keeps its baseline
and becomes its own skipped unit with `partition_too_large`. Every other packed
unit is exactly one terminal outcome: succeeded when exact-coverage model
output is accepted, or failed on lookup/config/call/shape/coverage failure. A
global model-resolution/configuration failure marks every non-oversized unit
failed with the same code; it does not erase oversized skipped units. A model may repartition and relabel only the
occurrences in one unit. Its result replaces that unit only after exact-once
occurrence coverage validates; malformed, missing, or duplicate keys retain
the complete baseline unit. Successful units survive failures elsewhere. All
accepted replacement clusters and retained baseline clusters are globally
re-ranked with the total comparator before return.

The response adds `provenance: 'deterministic' | 'model_refined'` to each
cluster and these top-level fields: nonnegative integer `inputCount`;
nonnegative integer `outputCount`; boolean `coverageComplete` (exact identity
multiset equality, not merely equal counts); boolean `refinementComplete`
(`refinementSucceeded === refinementTotal`); integer unit counts
`refinementTotal`, `refinementSucceeded`, `refinementFailed`, and
`refinementSkipped`, where the latter three always sum to `refinementTotal`;
and at most 50
`warnings: {unit: nonnegative integer | null, code: enum, count: positive integer}[]`.
An empty backlog has zero units and complete refinement.
Warning codes are `model_lookup_failed`, `model_unconfigured`,
`model_http_error`, `model_transport_error`, `model_invalid_response`,
`coverage_invalid`, `partition_too_large`, and `warnings_truncated`. There is
one terminal warning per failed/skipped unit, ordered by ascending unit then
code by UTF-16 code units. Equal code/unit rows are collapsed by incrementing
`count`. If more than 50 rows remain, retain the first 49 and append
`{unit:null, code:'warnings_truncated', count:<omitted row count>}`. `model` is nullable only when model
resolution fails; once resolved it names the attempted model even if every
call fails. Backlog failure remains 503. Model lookup/unavailability or
some/all batch failures return 200 with complete baseline results and warnings;
they never replace the baseline with 502/503. The compact UI puts a warning
above the usable ranked clusters rather than replacing them with a fatal error
card. The operator can immediately inspect and edit the result; warnings do
not hide the primary next action. This follows the Helios requirement that
operator pages optimize for the tenth visit, not force the operator to retry
until every stochastic dependency succeeds simultaneously.

## Required negative tests

Implementation is not complete without focused tests for:

1. no capability config, invalid attestation key/config, unavailable shared state;
2. malformed/unsigned/tampered envelope, shape digest mismatch, signature
   mismatch, unknown fields/version/action/spec/key, duplicate/unsorted rows;
3. missing/duplicate/mixed header families, cookie or bearer mixing, unknown
   request key, bad signature, bad host, wrong method/path/query/content type;
4. dot segments, encoded separators, fragments, malformed percent encoding,
   app-base-path confusion, and bare `?`;
5. timestamp outside skew, duplicate nonce, shared nonce-registry bounds, body digest
   mismatch, schema mismatch, body over 4 KiB, and idempotency retry behavior;
6. before activation, exact activation boundary, just before expiry, exact
   expiry boundary, requested TTL over 14 days, default four-hour TTL;
7. revoke and emergency revoke visible to two independently constructed
   verifier instances without restart; no resurrection from stale cache;
8. one malformed grant isolated from another valid grant;
9. capability headers cannot reach admin/session/navigation, readonly paths,
   Promote, persisted Remove/Undo, or any unregistered mutation;
10. readonly GET/HEAD behavior and normal OAuth/origin/RBAC behavior unchanged;
11. route-local guard runs before backlog/model/DB/git side effects and emits
    correlated authorization + action-outcome audit records;
12. signing and attestation private keys absent from client source, built
    assets, public env/config, responses, and logs;
13. clustering has exactly-once full input coverage and stable ranking when
    all, some, or no model batches succeed; Remove targets an exact occurrence
    and Undo restores aggregates, ranking, and focus in browser memory.

## Rollback

The immediate no-code rollback is authenticated emergency disable, then
individual grant revocation. After capabilities are drained or revoked,
removing the capability request-key and attestation-key configuration in a
normal Helios deploy disables only the new principal. Deleting reserved
`app_settings` rows is a separate production DB mutation and requires its own
operator authorization; expiry and revocation correctness do not require that
cleanup. The initial action writes no durable application state beyond its
bounded replay record. If code rollback is needed, canonically revert the
capability integration and deploy with `self-deploy-helios`; do not restart
serving units manually. Existing OAuth and signed-readonly paths remain the
fallback throughout.
