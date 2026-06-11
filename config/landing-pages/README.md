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
