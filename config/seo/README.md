# SEO bundle contracts (frozen — P0)

This directory holds the **frozen v1 contract** for the Helios-driven SEO
widgets bundle (parent epic
[virusdave/top-level#15](https://github.com/virusdave/top-level/issues/15),
child epic [FreshlyBakedNYC/automation#44](https://github.com/FreshlyBakedNYC/automation/issues/44)).

The SEO bundle is a **separate, independently-versioned, signed bundle**
that **reuses the unified-landing-engine (#13) publisher / signer /
`/cloud` atomic-pointer / validator / `lp_events` pipeline verbatim**
(`helios/src/server/lp/`). It is **not** merged into the LP bundle and
**not** a parallel crypto stack — see parent EPIC_PLAN §4.

## Source of truth

The **authoritative, typed contract** lives in the zod schemas at
[`helios/src/server/seo/contracts.ts`](../../helios/src/server/seo/contracts.ts).
The JSON files in [`examples/`](./examples) are illustrative fixtures that
are cross-checked against those zod schemas (and for full cross-artifact
consistency) by
[`helios/src/server/seo/contracts.test.ts`](../../helios/src/server/seo/contracts.test.ts).

(The peer `Nicponskis/mostly-static-sites` renderer owns its own copy of
the consuming contract; this directory is the Helios/control-plane side.)

## Bundle layout on `/cloud`

```
/<env>/current.json                      # mutable, atomic-rename pointer (signed)
/bundles/<seo_bundle_id>/manifest.json   # signed index: sites + host→mode + checksums
/bundles/<seo_bundle_id>/widgets.json    # placement + config of the 5 widgets
/bundles/<seo_bundle_id>/content.json    # approved FAQ sets / posts / related / heads
/bundles/<seo_bundle_id>/policy.json     # stable, versioned selection policy
/bundles/<seo_bundle_id>/assets.json     # content-addressed images + approval status
/bundles/<seo_bundle_id>/sitemaps.json   # sitemap/RSS manifest contents
```

`seo_bundle_id` form: `seob_YYYY-MM-DD_HHMMSS_<6 hex>` (UTC).

## The five widgets

`SEOFAQFold`, `WhatsNewFeed`, `BlogPost`, `RelatedLinks`, `SEOHead`
(parent EPIC_PLAN §6).

## Reserved Prefix Registry route (P0 decision)

The blog is **hosted content** and lives under the `/sites/<id>/` zone:

```
/sites/<id>/whats-new/<slug>
```

where `<id>` is a concrete site id **or** the reserved global token
**`all`** (`/sites/all/whats-new/<slug>`) for domain-boosting,
non-site-specific posts. **No physical site may use `all` as its id.**
There is **no** flat `/whats-new/<slug>` (operator rejected it), and
posts are **not** forced onto the LP `/SITE/PURPOSE/SLUG/NUM` schema.
Helpers: [`helios/src/server/seo/routeRegistry.ts`](../../helios/src/server/seo/routeRegistry.ts).

## Binding safety invariants (enforced fail-closed)

Enforced by the compiler (pre-publish) and the validator (post-read) in
[`helios/src/server/seo/consistency.ts`](../../helios/src/server/seo/consistency.ts):

- **Raw + sanitized completeness** — every FAQ/post carries both a `raw`
  and a `sanitized` variant (non-empty, schema-enforced), so a sanitized
  host (FB.us) is never left without compliant content and raw cannabis
  copy can never leak by omission. mss picks the variant by host mode.
- **No cloaking** — indexable content is stable per URL within a bundle;
  there is no separate JSON-LD text field that could drift from the
  visible answer (the renderer derives JSON-LD from the same source).
- **Approved assets only** — referenced hero/og images must exist, match
  their role, and be `approved`; `rejected`/`pending` never ship.
- **Scope validity** — every scope is a concrete site id or `all`.
- **Sitemap hygiene** — no `noindex`/disabled/missing post in the sitemap.
- **Human-approval gate (canon §1)** — the bundle only ever carries
  already-approved content (each item carries an `approval_id`); nothing
  in this pipeline auto-publishes.

## CLI (P1)

[`helios/src/server/seo/cli.ts`](../../helios/src/server/seo/cli.ts):

```sh
tsx helios/src/server/seo/cli.ts keygen
# dry-run (P1): compile + validate + write a candidate pointer to non-prod
tsx helios/src/server/seo/cli.ts build --root /cloud/seo --env nonprod \
    --config ./examples/bundle-input.example.json --privkey ./signing.pem
tsx helios/src/server/seo/cli.ts validate --root /cloud/seo --env nonprod \
    --pubkey ./signing.pub.pem --renderer 0.1.0
```

`build` writes only a **candidate** pointer (never the live
`current.json`); `publish` flips the live pointer and is operator-only
against prod (canon §1).
