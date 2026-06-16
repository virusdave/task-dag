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

**Guards that fail the publish:** invalid `sweedBrandId`; a `(site, slug)`
collision to a different brand id; a duplicate `opaque_ref` mapping to a
different brand id; a literal slug equal to an opaque ref in the same
location. Rows mss would not generate (non-FB-US site, empty trimmed
name/slug, never-for-sale) are **excluded** (subset invariant), not errors.

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

2. **A canonical-registry slug collision must be resolved (the §6.5.1
   overlay-fixup migration).** Running the producer read-only against the live
   registry surfaced a real collision at **bronx**: brand ids `1902`
   ("Dr. Jekyll And Mr. High") and `16413` ("Dr Jekyll and Mr High") both
   slugify to `dr-jekyll-and-mr-high`. This is the "split-then-merged"
   duplicate the mss comment describes: mss resolves it via the FB-US overlay
   DB marking one id `status='retired'` (keyed by `sweedBrandId`) *before* its
   collision check. Helios's canonical registry has no such retirement flag,
   so the producer fails loud (correct — better than emitting a manifest entry
   whose opaque page mss never generated). The clean, #13-aligned fix is to
   migrate the residual overlay fixups (retired-by-slug, `sweedBrandId`
   override) **into Helios** so the canonical registry alone disambiguates.
   That migration is separate, follow-on work.

Until both are done, the actual prod publish stays gated. mss P1 can already
build against the **agreed contract** above (schema + golden vectors).
