# Branding `literal-slug → opaque-ref` manifest — Helios producer contract

> Deliverable for **P1-prereq** of the Helios child epic of the
> opaque-`branding/`-slugs epic (ownership decision (ii): Helios is the
> SINGLE PRODUCER of the manifest).
> Issue: [FreshlyBakedNYC/automation#48](https://github.com/FreshlyBakedNYC/automation/issues/48)
> · parent: [virusdave/top-level#19](https://github.com/virusdave/top-level/issues/19)
> · authoritative plan: `virusdave/top-level : docs/epics/branding-opaque-slugs/EPIC_PLAN.md` (§4, §5 P1-prereq, §6.5, §6.5.1).
>
> This documents the manifest the consumers (mss P1 ingest + the operator's
> Ads-Editor CSV migration in P4) rely on, and records the two operator-side
> prerequisites that gate the actual **production publish** (which is the
> operator-gated rollout, parent §5 P4 — NOT this task).

## What landed (P1-prereq, the producer)

`helios/src/server/branding/`:

- [`opaqueRef.ts`](../../../helios/src/server/branding/opaqueRef.ts) — pure,
  env-free replica of the mss authoritative opaque-public-ref scheme
  (`Nicponskis/mostly-static-sites : apps/freshlybakedus-site/lib/opaque-public-ref-core.ts`).
  The cross-repo contract is the **checked-in golden vectors** in
  [`opaqueRef.test.ts`](../../../helios/src/server/branding/opaqueRef.test.ts),
  which are byte-identical to mss's frozen vectors. Changing the algorithm,
  scope string, version token, truncation length, or fallback secret silently
  404s live Google-Ads URLs; a vector failure means "revert", never
  "regenerate".
- [`manifest.ts`](../../../helios/src/server/branding/manifest.ts) — the
  deterministic builder + zod contract + guards. Reproduces mss's
  `slugifyStorefrontPathSegment` + canonical-presence filters +
  slug-collision detection so the manifest is a **subset** of the pages mss's
  `generateStaticParams` emits.
- [`secret.ts`](../../../helios/src/server/branding/secret.ts) — resolves
  `FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET`; the prod publish path **fails closed**
  if only the non-production fallback is available.
- [`publish.ts`](../../../helios/src/server/branding/publish.ts) — signed
  (ed25519), versioned, atomic-pointer publisher + read-time validator,
  reusing the lp-bundle signing/canonical-JSON/atomic-write primitives but a
  **separate** artifact subtree/schema/version namespace.
- [`db.ts`](../../../helios/src/server/branding/db.ts) — read-only query of
  `landingpage_brand_site_presence` (mirrors mss `fetchHeliosBrandPresence`).
- [`cli.ts`](../../../helios/src/server/branding/cli.ts) — `build` (read-only
  preview), `publish`, `validate`.

## The opaque-ref scheme (shared contract)

```
opaque_ref = HMAC_SHA256(secret, "v1\0" + "fbus-branding" + "\0" + "v1\0" + String(sweedBrandId))
             .digest("base64url").slice(0, 20)
```

Frozen golden vectors (non-production fallback secret
`freshlybakedus-nonproduction-public-token-secret`):

| sweedBrandId | opaque_ref |
|---|---|
| 1 | `43HM0632radpVvEdiYWj` |
| 42 | `-NjvyVs1MrN2lrEA71Vv` |
| 1234 | `h78SFgtcQNLHNzKo37r1` |
| 987654 | `7UJAMUE0KiXD3vZgHQiU` |

The opaque ref is keyed on the **immutable** `sweedBrandId` (the registry
`brand_id`), never the display name/slug, so a brand's public URL is stable
across renames.

## Manifest shape (`freshlybaked.branding-opaque-manifest.v1`)

```jsonc
{
  "schema": "freshlybaked.branding-opaque-manifest.v1",
  "manifest_id": "bom_2026-06-16_153000_ab12cd",
  "scheme": { "algorithm": "hmac-sha256-base64url-truncated", "scheme_version": "v1",
              "scope": "fbus-branding", "value_version": "v1", "ref_length": 20 },
  "secret_source": "production" | "nonproduction-fallback",
  "automation_git_sha": "…",
  "entries": [
    { "site_key": "bronx", "literal_slug": "herb", "sweed_brand_id": 1234,
      "opaque_ref": "h78SFgtcQNLHNzKo37r1" }
  ],  // sorted by (site_key, literal_slug, sweed_brand_id)
  "signature": "ed25519:…"
}
```

Published under `<artifactRoot>/branding-opaque/manifests/<manifest_id>/manifest.json`
with an atomically-swapped signed pointer at
`<artifactRoot>/branding-opaque/<env>/current.json`
(`freshlybaked.branding-opaque.current.v1`).

**Guards that fail the publish:** invalid `sweedBrandId`; a duplicate
`opaque_ref` mapping to a different brand id; a literal slug equal to an
opaque ref in the same location. Rows mss would not generate (non-FB-US
site, empty trimmed name/slug, operator soft-retired `DEAD -`/`RETIRED`
names, never-for-sale) are **excluded** (subset invariant), not errors.

### Slug collisions are resolved, not fatal (operator decision, #48)

Two different `sweedBrandId`s whose names slugify to the same
`(site, slug)` are a duplicate-Sweed-brand-record hazard. mss resolves it
via its overlay DB (retiring one id); Helios's canonical registry has no
explicit retire flag. Rather than hard-fail the whole build on one stale
duplicate (which would block **every** prod publish), the builder resolves
each collision deterministically and reports it:

- **`skipped-disabled`** — exactly one of the colliding brands is *live*
  (for sale anywhere in the FB-US footprint). The live brand wins; the
  disabled/stale duplicates are skipped. Benign.
- **`ambiguous`** — zero or ≥2 colliding brands are live, so there is no
  single obvious winner. The build still emits ONE deterministic winner
  (highest current for-sale count → most recent last-for-sale → lowest
  `sweedBrandId`) so a stale duplicate never blocks prod, but flags the
  group for operator attention.

Each collision is printed loudly by the CLI (`build` and `publish`). The
CLI **pages the operator** (`page-dave`) when the collision picture is
abnormal — more than the one known benign group, or any `ambiguous` group.
The single live collision today (`bronx/dr-jekyll-and-mr-high`: live brand
`1902` kept, stale `16413` skipped) resolves as `skipped-disabled` and does
**not** page. The clean #13-aligned end state still migrates mss's overlay
fixups into Helios so the canonical registry alone disambiguates.

## Two prerequisites that gate the production PUBLISH (operator-side)

The producer is complete and green, but it cannot emit a *production-correct*
manifest today. Both items below are explicitly deferred by the parent plan
(§5 P4 rollout, §6.5.1 clean end-state) and are **out of P1-prereq scope**:

1. **`FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET` is not provisioned into Helios.**
   mss is not deployed on the Helios host and the secret is absent from
   Helios's environment. A manifest built with the non-production fallback
   secret would `308` live Google-Ads URLs to non-existent opaque pages
   (404), so `publish --env prod` fails closed without the real secret. The
   secret must be provisioned into Helios (e.g. via `nixos-sbc` +
   `self-deploy`, operator approval) before a prod manifest can be produced.

2. **~~A canonical-registry slug collision must be resolved~~ — RESOLVED in
   the builder (#48).** Running the producer read-only against the live
   registry surfaced a real collision at **bronx**: brand ids `1902`
   ("Dr. Jekyll And Mr. High") and `16413` ("Dr Jekyll and Mr High") both
   slugify to `dr-jekyll-and-mr-high`. The producer no longer hard-fails on
   this: per the operator decision (#48) it skips the disabled duplicate
   (`16413`, not for sale anywhere in the FB-US footprint) in favour of the
   live brand (`1902`) and reports it loudly (see "Slug collisions are
   resolved, not fatal" above). So this no longer gates the prod publish.
   The clean, #13-aligned end state still migrates the residual mss overlay
   fixups (retired-by-slug, `sweedBrandId` override) **into Helios** so the
   canonical registry alone disambiguates — that is separate, follow-on work.

Until item 1 is done, the actual prod publish stays gated. mss P1 can already
build against the **agreed contract** above (schema + golden vectors).

> **On item 1 — why does Helios need the secret?** Only because the manifest
> currently emits the final `opaque_ref` (so the operator's Ads-Editor CSV
> migration can read literal-URL → opaque-URL directly). The opaque ref is
> `HMAC(secret, sweedBrandId)`; to emit prod-correct refs Helios needs the
> same secret mss uses, or every literal `308` lands on an opaque page mss
> can't decode (→ 404). Helios does **not** need the secret to *know the
> mapping* — it already emits the immutable `sweed_brand_id` per entry, and
> any secret-holder (mss) can derive the opaque ref from that. So an
> alternative is: Helios publishes `literal_slug → sweed_brand_id` only, and
> the secret-holding consumer derives the opaque ref. That keeps the secret
> out of Helios entirely, at the cost of moving the literal→opaque CSV
> derivation to a secret-holding step. **Operator decision required** before
> changing the agreed mss contract (which today includes `opaque_ref`).
