# Opaque `branding/` slugs — `automation` (Helios) in-repo facts

> Deliverable for the **"First task: confirm the in-repo facts"** of the
> Helios child epic of the opaque-`branding/`-slugs epic.
> Issue: [FreshlyBakedNYC/automation#48](https://github.com/FreshlyBakedNYC/automation/issues/48)
> · parent: [virusdave/top-level#19](https://github.com/virusdave/top-level/issues/19)
> · authoritative plan: `virusdave/top-level : docs/epics/branding-opaque-slugs/EPIC_PLAN.md`.
>
> The top-level/mss repos cannot read `automation` source. This file is the
> read-only enumeration they asked for so the **shared `brand-id → opaque-ref`
> contract** can be agreed before any code emits opaque branding refs (parent
> §7, child epic "Coordination"). **No behavior is changed by this commit.**

## TL;DR

1. **Helios does not construct the `branding/` `SLUG` path segment.** Per the
   binding scope (#13 §6 / parent §0), Helios only decides **`NUM`** and
   publishes a signed bundle/policy/kill-list that the mss middleware
   evaluates locally. The `SLUG` (brand id) lives in **mss**'s route +
   registry, not in Helios.
2. The **only signed Helios artifact that names a literal `branding/` slug**
   is the **kill-list** (`current.json` → `disabled_variants[].slug`), which
   is **operator-authored** config, not auto-generated.
3. `cluster_slug` flows through Helios as an **analytics dimension only**
   (lp-events → rollups); it is not used to build any emitted URL.
4. The literal `branding/<brand>/0` final URL appears **hardcoded in one
   one-off ad-generator script**; the morning CSV generator only **passes
   through** whatever `final_url` an existing ad already has.
5. **There is no opaque-ref builder anywhere in `automation`** — the
   `buildFreshlyBakedUsOpaquePublicRef` equivalent lives entirely in mss.
   So P3 cannot "reuse the in-repo helper"; it must consume the **shared
   contract mss publishes**.
6. **Production probe (2026-06-15):** `GET /bronx/branding/herb/0` →
   `307` re-roll to `?utm_content=NUM:3` on the **literal** slug, **no**
   literal→opaque `308`. mss P0–P2 for `branding/` have **not shipped**, so
   P3 (Helios emits opaque) is correctly **gated** on them (parent order
   P0→P1→P2→P3→P4).

## 1. Where Helios references a `branding/` row's `SLUG` (literal today)

### 1a. Signed kill-list — `current.json` → `disabled_variants[].slug`
The only place a Helios-signed artifact carries a literal branding slug.

- Schema: `DisabledVariantSchema` (`site`, `purpose`, `slug`, `num`, …) —
  [`helios/src/server/lp/contracts.ts:25`](../../../helios/src/server/lp/contracts.ts#L25)
  (`slug` at [L29](../../../helios/src/server/lp/contracts.ts#L29)); carried on
  `CurrentPointerSchema.disabled_variants`.
- Bounds/drift guard: `checkDisabledVariantBounds` /
  `checkBundleConsistency` —
  [`helios/src/server/lp/registryCheck.ts`](../../../helios/src/server/lp/registryCheck.ts)
  (label `disabled_variant ${site}/${purpose}/${slug}/${num}`). This guard
  today validates only that `num ≤ MAX_VARIANT_BY_PURPOSE`; it does **not**
  check that `slug` resolves in the mss registry.
- Source of the values: **operator-supplied** `disabledVariants` config
  threaded through the compile/publish CLI —
  [`helios/src/server/lp/cli.ts:109`](../../../helios/src/server/lp/cli.ts#L109)
  → [`compile.ts:80`](../../../helios/src/server/lp/compile.ts#L80) (pre-publish)
  and re-checked post-read in
  [`validate.ts:133`](../../../helios/src/server/lp/validate.ts#L133).

### 1b. Bandit / `NUM` emission keys on `family` / `cluster_slug`, not brand slug
The bundle/policy never carry a per-brand branding slug. Selection is keyed by
`family` (and optional `cluster_slug`) and biases per-`NUM` weights:

- `PolicyRule.match.{site,family,cluster_slug}` and per-slot exploit/explore
  variant ids —
  [`contracts.ts:156`](../../../helios/src/server/lp/contracts.ts#L156),
  validated in
  [`registryCheck.ts`](../../../helios/src/server/lp/registryCheck.ts)
  (`match.family` must exist in `bundle.families`).

### 1c. `cluster_slug` — analytics dimension only
Persisted from the lp-events ingest and rolled up; never used to build a URL:

- `LpEvent.cluster_slug` —
  [`contracts.ts:234`](../../../helios/src/server/lp/contracts.ts#L234).
- Persisted —
  [`helios/src/server/db/queries/lpEventsQueries.ts:48`](../../../helios/src/server/db/queries/lpEventsQueries.ts#L48).
- Rolled up —
  [`helios/src/server/db/queries/gadsLpRollupQueries.ts:115`](../../../helios/src/server/db/queries/gadsLpRollupQueries.ts#L115).

## 2. Ad-final-URL / ValueTrack producers that build `branding/` `/0` URLs

- **Literal, hardcoded** in a one-off generator:
  `const FINAL_URL = 'https://freshlybaked.us/bronx/branding/herb/0'` —
  [`ads/google/scripts/generate-bronx-conquest.mjs:41`](../../../ads/google/scripts/generate-bronx-conquest.mjs#L41)
  (used for both the ad rows and the HTML summary). This is the clearest
  in-repo "ad-final-URL producer" of a literal `branding/<brand>/0` URL.
- **Pass-through only** (not a producer): the L2 morning CSV generator copies
  `final_url` from the existing creative/snapshot/known-ad — it never
  constructs a `branding/` URL itself —
  [`ads/google/lib/l2/csv-generator.ts`](../../../ads/google/lib/l2/csv-generator.ts)
  (`final_url` plumbing around L298–L945). So a literal branding final URL
  enters via the Ads snapshot, not via Helios synthesis.

## 3. How `compare/` / `conquest/` emit opaque refs (the helper to reuse)

**They don't, in `automation`.** A repo-wide search for an opaque-ref builder
(`buildFreshlyBakedUsOpaquePublicRef`, `*OpaquePublicRef`, `buildOpaque`, …)
returns **zero** matches in `helios/`, `ads/`, and `config/`. The
`generate-bronx-conquest.mjs` script even points a *conquest* campaign at a
**literal** `branding/herb/0` URL ([§2](#2-ad-final-url--valuetrack-producers-that-build-branding-0-urls)).

Consequence for P3: the opaque scheme is **owned by mss**
(`apps/freshlybakedus-site/lib/purpose-families.ts :
buildFreshlyBakedUsOpaquePublicRef`, per parent §1). Helios must consume the
**shared output contract** mss publishes — checked-in test vectors / a
generated manifest / an importable package (parent §7) — not re-implement the
hash. The CI parity test (parent §8, child Verification) proves identical
`brand-id → opaque-ref` against that artifact.

## 4. What P3 will actually change here (for the contract discussion)

When mss P0–P2 are live and the contract is agreed, the in-repo edits are
small and localized:

1. **Kill-list emission** ([§1a](#1a-signed-kill-list--currentjson--disabled_variantsslug)):
   operator-authored `branding` `disabled_variants[].slug` become the **opaque**
   ref (or are mapped literal→opaque at compile time).
2. **Parity check** (parent's "bundle-compile parity check"): extend
   `checkDisabledVariantBounds` / `checkBundleConsistency` in
   [`registryCheck.ts`](../../../helios/src/server/lp/registryCheck.ts) so every
   emitted `branding` ref must **resolve in the mss registry** — same spirit as
   the existing `MAX_VARIANT_BY_PURPOSE` drift guard — so Helios can never
   publish an opaque ref mss cannot decode. Already wired into both compile
   ([`compile.ts:80`](../../../helios/src/server/lp/compile.ts#L80)) and read-time
   validate ([`validate.ts:133`](../../../helios/src/server/lp/validate.ts#L133)).
3. **Literal→opaque mapping output** (operator chose **migrate**, parent §6.2):
   emit the `brand-id → opaque-ref` mapping for every affected `branding/` `/0`
   final URL — the input for the operator's one-off Ads-Editor CSV migration.
   Agents do **not** touch the Ads account.
4. **One-off ad generator** ([§2](#2-ad-final-url--valuetrack-producers-that-build-branding-0-urls)):
   `generate-bronx-conquest.mjs`'s hardcoded literal `FINAL_URL` should emit the
   opaque form once the scheme is shared (low priority — it's a one-off).

## 5. Blocker / sequencing

P3 is **blocked** on the parent's strict ordering: mss must serve opaque **and**
protect literal URLs (P0–P2) before Helios emits opaque branding refs, and the
shared `brand-id → opaque-ref` **contract** must be agreed first (parent §5,
§7; child "Coordination"). The 2026-06-15 prod probe
([TL;DR #6](#tldr)) confirms mss P0–P2 for `branding/` are not yet live.
