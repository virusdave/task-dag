# Landing-page engine — Helios control-plane config & contracts (P0)

This directory is the **Helios-owned source of truth** for the unified
landing-page engine (top-level epic
[virusdave/top-level#13](https://github.com/virusdave/top-level/issues/13),
child epic `FreshlyBakedNYC/automation#42`).

> **Authoritative design:** the parent
> [`EPIC_PLAN.md`](https://github.com/virusdave/top-level/blob/master/docs/epics/unified-landing-engine/EPIC_PLAN.md)
> (rev 3). This directory implements its §4 ownership boundaries and the
> §5 / §6 / §8 contracts. If anything here drifts from the parent, the
> parent wins.

## What this is (and the phase it belongs to)

This is the **P0 "Contracts & flags"** deliverable for the Helios slice
(parent §10): the **frozen, versioned schemas** that bind Helios (the
producer) to the `mostly-static-sites` thin runtime (the consumer), plus
the feature-flag contract. P0 has **no live-traffic impact** — it only
freezes interfaces so P1+ (publisher dry-run, mss loader, shadow-compare)
can be built independently on both sides without churn.

Nothing here selects a variant, publishes a bundle, or touches the DB
yet; those are later phases.

## Layout

```
config/landing-pages/
  README.md                 ← this file
  FLAGS.md                  ← the LP_* feature-flag contract (parent §10)
  schemas/                  ← frozen JSON-Schema contracts (draft-07)
    current.v1.schema.json          # the atomic pointer + signed kill-list
    bundle-manifest.v1.schema.json  # signed index + checksums
    bundle.v1.schema.json           # sites, families, frozen components
    policy.v1.schema.json           # declarative selection policy (CEL-output)
    assets.v1.schema.json           # per-slot variant pool + approval status
    lp-events-batch.v1.schema.json  # POST /v1/lp-events/batch body
  examples/                 ← one conforming example per schema (fixtures)
    current.v1.json
    bundle-manifest.v1.json
    bundle.v1.json
    policy.v1.json
    assets.v1.json
    lp-events-batch.v1.json
```

Later phases add (not in P0): `families/<family>.blueprint.jsonc`,
`sites.jsonc` (migrated from mss `sites.yaml`), the frozen X2
`trust-anchor-cash-debit.jsonc`, and `policies/` templates (parent §4).

## The published artifact layout (what the publisher will write)

Per parent §5, Helios publishes immutable, content-addressed artifacts
to the read-only-for-mss `/cloud` mount; `current.json` is the only
mutable object and is swapped via atomic same-dir `rename()`:

```
/prod/current.json                         # atomic pointer (mutable)  → current.v1.schema.json
/bundles/<bundle_id>/manifest.json         # signed index + checksums  → bundle-manifest.v1.schema.json
/bundles/<bundle_id>/bundle.json           # sites/families/components  → bundle.v1.schema.json
/bundles/<bundle_id>/policy.json           # selection policy           → policy.v1.schema.json
/bundles/<bundle_id>/assets.json           # variant pool + asset refs  → assets.v1.schema.json
/assets/<sha256>/...                       # content-addressed blobs
```

**Signing keys live with Helios only — never on the shared `/cloud`
mount** (parent §5, decision 5).

## Operator approval → candidate publish (P5 — implemented)

From P5 ("Dual-publish; stop cross-repo writes", parent §10), operator
approval of new landing-page content is wired to a single sanctioned
action — **build + validate + publish a candidate bundle** — and the
legacy cross-repo commit producer is **off by default**
(`LP_CROSSREPO_COMMIT_PRODUCER=false`, see [`FLAGS.md`](./FLAGS.md)):

```sh
tsx helios/src/server/lp/cli.ts publish-candidate \
    --root /cloud/lp --env prod \
    --config ./approved-content.json --privkey ./signing.pem
```

- Writes the immutable, content-addressed bundle files and a **candidate
  pointer** `current.candidate.json`. It **never** swaps the live
  `current.json` — the existing live bundle stays frozen as the
  last-known-good fallback.
- Fail-closed self-validates the candidate (schema + `sha256` +
  signature + `min_renderer_version` + path-safety); a candidate that
  fails validation is reported and never staged for promotion.
- Promoting a candidate to live traffic is the separate, **operator-
  gated P6 canary** pointer flip (canon §1: no auto-publish of
  user-visible content). `--enable-crossrepo-producer` re-enables the
  legacy path as the P5 rollback lever.

Implemented in `helios/src/server/lp/publishCandidate.ts`
(`publishApprovedContentCandidate`) + the `publish-candidate` CLI
subcommand. The candidate is staged to a unique pending file, validated,
and only then atomically promoted to `current.candidate.json`, so a
candidate that fails validation can never be picked up by promotion.

## Canary promotion + rollback (P6 — tooling implemented; live ramp operator-gated)

P6 ("Canary cutover", parent §10) is where a validated candidate is
actually served. The **tooling** is implemented and tested; **running it
against the prod `/cloud` root flips live ad traffic and is an operator
action** (canon §1), as is any `LP_RUNTIME_MODE` / `LP_V2_PERCENT` /
allowlist change.

```sh
# Promote the staged candidate to the live current.json:
tsx helios/src/server/lp/cli.ts promote-candidate --root /cloud/lp --env prod \
    --privkey ./signing.pem --pubkey ./signing.pub.pem --renderer <deployed-mss-version>

# Roll back to a previous known-good bundle (forward publish, never a rewrite):
tsx helios/src/server/lp/cli.ts rollback --root /cloud/lp --env prod \
    --to-bundle <bundle_id> --privkey ./signing.pem --pubkey ./signing.pub.pem \
    --renderer <deployed-mss-version>
```

- Both write a **new, higher-versioned, freshly-signed** `current.json`
  atomically and re-validate it. Promotion enforces version monotonicity
  (`candidate.version == live+1`; stale candidates are rejected unless
  `--allow-version-rebase`). Rollback preserves the current kill-list by
  default. (parent §5: rollback is a forward publish, never a re-write of
  an old pointer.)
- **Revenue guardrail** (parent §10 P6: auto-revert if conversion drops
  >15% vs baseline for 5 min) — the pure decision logic is implemented in
  `helios/src/server/lp/revenueGuardrail.ts` (`evaluateRevenueGuardrail`):
  fail-safe on stale/thin data, and **auto-revert is disabled by
  default** (a breach yields an *alert*, not an automatic pointer flip).
  Wiring it into a periodic `lp_events`-querying job that can write
  `current.json` is an operator-gated step that first needs a written DB
  cost budget + an Oracle DB-efficiency review (canon §3).

Implemented in `helios/src/server/lp/promoteCandidate.ts`
(`promoteCandidate`, `rollbackToBundle`) + `revenueGuardrail.ts`, with
the `promote-candidate` / `rollback` CLI subcommands.

## Event ingest endpoint (P1 — implemented)

The conversion-feedback sink (parent §9) is live in Helios:

```
POST /v1/lp-events/batch        body → lp-events-batch.v1.schema.json
```

- **Consumer:** the mostly-static-sites landing runtime's durable
  spool + 15-minute batch flusher (mss P2). Nothing serves v2 yet, so
  no production traffic writes here until later phases — the endpoint
  is stood up now so the contract is exercisable end-to-end.
- **Auth:** `Authorization: Bearer <LP_EVENTS_INGEST_TOKEN>`, compared
  constant-time. Unset token ⇒ `503` (fail-closed); missing/mismatched
  bearer ⇒ `401`. Provision the secret the same way as
  `VERISCAN_WEBHOOK_TOKEN` (agenix → systemd `EnvironmentFile`).
- **Storage:** append-only `lp_events` table (Helios migration
  `070_lp_events.sql`). Idempotent by the runtime-assigned `event_id`
  (`on conflict do nothing`), so an interrupted flush can safely
  re-send. Every row carries `assignment_id` / `bundle_id` / `policy_id`
  provenance for the P3 parity dashboard and the conversion loop.
- **Response:** `200 {received, inserted, duplicates}`. If the table is
  missing the route returns `503` (operator: apply migration 070) and
  the runtime keeps the batch spooled rather than dropping it.

## Binding constraints (do not violate in any phase)

- **No URL-schema changes.** The canonical FB-US schema
  `/SITE/PURPOSE/SLUG/NUM` (with `NUM=0` = the random-rotation
  distributor alias and `utm_content=NUM:N` branch tracking) is
  unchanged. The engine only changes **who decides `NUM`** — Helios
  publishes per-`NUM` weights + a kill-list, evaluated locally by the
  existing mss middleware (parent §6.1).
- **`NUM` must exist in the mss registry.** Every variant id / `num` a
  policy or kill-list references must respect the mss-owned
  `MAX_VARIANT_BY_PURPOSE` / per-purpose `*VariantIds` registry. The
  bundle compiler validates this at compile time and must never emit a
  `NUM` mss cannot serve.
- **X2 is frozen.** The trust-anchor (cash/debit) component is a fixed
  slot; any change to it is a `page-dave -p 4` event (parent §7,
  decision 2).
- **Fail-closed.** A bundle that fails schema / `sha256` / signature /
  `min_renderer_version` validation is never served; mss keeps the
  last-known-good and fires `page-dave -p 4` (parent §5 step 6).
- **Determinism of the policy evaluator.** The selection policy is
  evaluated with no impure nondeterminism (no clock, no RNG, no I/O);
  randomized scatter is supplied as a **deterministic HMAC bucket input**
  derived from the per-click assignment key (parent §6). CEL, never
  `eval` (decision 1).

## Versioning

Each schema carries a `schema` discriminator string of the form
`freshlybaked.lp.<artifact>.vN`. Breaking changes bump `N` and ship a
new `*.vN.schema.json` file; the old version stays until all consumers
move. `current.json.version` is a **monotonic integer**: mss ignores any
pointer whose `version` is ≤ its active version (so rollback is a *new*
higher-versioned pointer that references the previous good `bundle_id`,
never a rewrite — parent §5).

## Validating the contract

The example fixtures under `examples/` each conform to their schema. To
re-validate after editing a schema or example:

```sh
scripts/validate-lp-contracts        # see scripts/validate-lp-contracts
```
