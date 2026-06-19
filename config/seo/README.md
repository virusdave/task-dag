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

### Sourcing approved content from the control plane (P3/P4)

Instead of hand-listing content in the config JSON, the build/publish
commands can pull the operator-**approved** rows straight from the
control-plane DB (each is re-verified against the append-only
`seo_approvals` ledger, so a broken approval record fails the build
loudly rather than shipping):

```sh
tsx helios/src/server/seo/cli.ts build --root /cloud/seo --env nonprod \
    --config ./bundle-input.json --privkey ./signing.pem \
    --faq-from-db --posts-from-db --assets-from-db --sitemaps-from-posts
```

- `--faq-from-db` — approved FAQ sets ([`faqBundleSource.ts`](../../helios/src/server/seo/faqBundleSource.ts)).
- `--posts-from-db` — approved, released blog posts ([`postBundleSource.ts`](../../helios/src/server/seo/postBundleSource.ts)).
- `--assets-from-db` — approved image assets ([`imageAssetBundleSource.ts`](../../helios/src/server/seo/imageAssetBundleSource.ts)).
- `--sitemaps-from-posts` — **regenerate** the per-post `sitemaps.json`
  entries from the posts now in `content.posts` (whether they came from
  `--posts-from-db` or the static config), merged with the config's
  **static** (non-post) URLs ([`postSitemapUrls.ts`](../../helios/src/server/seo/postSitemapUrls.ts)).
  The generator OWNS every post-bound entry: each is derived from the
  post's own `canonical_url`, `noindex`/kill-listed posts are skipped,
  and a stale hand-listed post URL (a `/sites/<id>/whats-new/<slug>`
  loc with no `post_id`) is **rejected** so the sitemap can never drift
  from the approved content. This is the "sitemap/RSS update from the
  bundle" half of P4.

### No separate `feeds.json` — RSS/feed derive from `content.json`

The bundle layout is the frozen **five files** above. There is
deliberately **no** `feeds.json`/`rss.xml` artifact: the RSS feed and the
`WhatsNewFeed` widget are rendered by mss from `content.json` posts
(ordered by `published_at`), and the `sitemaps.json` URL list above. The
renderer **must** filter those to indexable posts only — `noindex !==
true` and not on the `current.json` `disabled_content` post kill-list —
so a post excluded from the sitemap can never leak into RSS/feed output.
