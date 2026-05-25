# LitAlerts parsing live-review — Epic plan

Authoritative scope: [issue #19](https://github.com/FreshlyBakedNYC/automation/issues/19).
Sibling work / shared substrate:
[`docs/helios/parsekit/EPIC_PLAN.md`](../parsekit/EPIC_PLAN.md) (the
parsekit runtime + `helios-parser-configs` repo) and the existing
METRC pending-purchases live-review page
[`ConfigParsingPendingPurchasesPage.tsx`](../../../helios/src/client/routes/config/ConfigParsingPendingPurchasesPage.tsx)
backed by
[`configParsing.ts`](../../../helios/src/server/routes/configParsing.ts).

## Why this epic exists

LitAlerts is the second parsekit use-case the runtime was designed for
(see [parsekit DESIGN_v1 §13 forward-compat constraints](../parsekit/DESIGN_v1.md))
but zero parser configs have actually been scaffolded for it. The
`helios-parser-configs` repo today contains `use-cases/pending-purchases/`
and the supporting `metrc-v1` dialect but the planned
`use-cases/litalerts/` directory and `litalerts-v1` dialect pack do not
exist yet. As a result, every LitAlerts payload still flows through
legacy ad-hoc parsing that nobody can review, diff, or correct without
shipping code.

This epic delivers three things:

1. The first **real** `litalerts-v1` dialect + per-competitor
   parser configs + golden corpus, committed to `helios-parser-configs`.
2. A reviewer-facing **Config → Parsing → LitAlerts** page in Helios
   (`/config/parsing/litalerts`) that mirrors the existing METRC page
   but is competitor-keyed and surfaces the FuzzySku records that fall
   out of each parse.
3. An **embedded LLM chat panel** on that page that proposes parser-
   config diffs (Bedrock-mantle Claude Sonnet-class model, the same
   gateway as
   [`reviewSentimentGate.ts`](../../../helios/src/server/llm/reviewSentimentGate.ts)),
   previews the before/after match implications across the visible
   sample and on demand across the full affected population, and on
   operator confirmation commits + pushes the diff to
   `helios-parser-configs` master through the existing
   [`gitMirror`](../../../helios/src/lib/parsekit/node/gitMirror.ts)
   path so the next loader refresh picks it up.

## Non-goals

- Catalog ↔ FuzzySku matching is epic D (a separate issue). This epic
  stops at producing the FuzzySku records and showing them next to
  the raw payload.
- **No** auto-apply of LLM diffs. The chat proposes; a human
  explicitly clicks Apply, at which point Helios stages a real commit
  on a working clone of the configs repo, pushes to master, and waits
  for the loader to reload.
- Authoring a custom DSL or wholesale rewriting parsekit. The
  dialect/config files are JSONC ASTs per the parsekit defaults table.
- Touching the METRC pending-purchases page or its dialect — this epic
  is additive next to it.

## Architecture overview

```diagram
╭───────────────────────────────────────────────────────╮
│ helios-parser-configs (FreshlyBakedNYC/…) master      │
│   use-cases/litalerts/                                │
│     dialects/litalerts-v1@1.jsonc       NEW           │
│     parsers/<competitorId>.jsonc        NEW (per NY)  │
│     goldens/<competitorId>/*.json       NEW corpus    │
│   release.json (manifest)               (bump SHA)    │
╰─────────────────────────┬─────────────────────────────╯
                          │ syncMirror() poll + fs.watch
                          ▼
╭───────────────────────────────────────────────────────╮
│ helios server: ParserRegistry (parsekit/node)         │
│   stage → compile closure → run scoped goldens        │
│   → atomic generation swap                            │
╰────────────┬────────────────────────┬─────────────────╯
             │ getStatus()/current()  │ parse(scope,…)
             ▼                        ▼
╭───────────────────────────╮  ╭──────────────────────────╮
│ /api/config/parsing/      │  │ litalerts ingest worker  │
│   litalerts               │  │   ⇒ FuzzySku records     │
╰────────────┬──────────────╯  ╰──────────────────────────╯
             │
             ▼
╭───────────────────────────────────────────────────────╮
│ SPA  /config/parsing/litalerts                        │
│   per-competitor row:                                 │
│     • current config + last-load status               │
│     • recent payload sample + emitted FuzzySku        │
│     • diff preview when config edited in-memory       │
│   sticky LLM chat panel:                              │
│     • describe inadequacy                             │
│     • model returns proposed JSONC patch + rationale  │
│     • full-population impact button                   │
│     • Apply → server commits + pushes configs repo    │
╰───────────────────────────────────────────────────────╯
```

The existing METRC slice already implements the
ParserRegistry-status / recent-events / per-row diff shape; the
LitAlerts page is intentionally a sibling, not a fork.

## Phase breakdown

The work decomposes into five phases that can each ship and be
reviewed independently. Each phase ends with a deployable artifact
behind a feature flag (default off) until the final flip in P5.

| Phase | Deliverable | Status |
| ----- | ----------- | ------ |
| L1 — `litalerts-v1` dialect + first parser config in `helios-parser-configs` | Dialect JSONC, single seed competitor config, golden corpus skeleton, release.json bump. Loader picks it up; nothing on the SPA yet. | shipped (dialect in `helios/src/lib/parsekit/dialects/litalerts-v1.ts`; seed config at `helios-parser-configs/use-cases/litalerts/parsers/bayside-cannabis.jsonc`; loader verified end-to-end via real `loadParserConfigsFromDir`) |
| L2 — per-competitor coverage + ingest wiring | Seed configs for every NY competitor we currently consume; ingest path calls `parsekit.parse({useCase:'litalerts', tenantId:<competitor>, input:<sku>})` in shadow mode (parse + log diff vs legacy), behind `HELIOS_LITALERTS_PARSEKIT_SHADOW` env flag. | partial — read-path cutover landed in commit `ebb96d0`; only `bayside-cannabis` has a parser config so far. Per-competitor backfill + shadow-mode telemetry still pending. |
| L3 — `/config/parsing/litalerts` read-only review page | New SPA route + `GET /api/config/parsing/litalerts` returning per-competitor status, recent payloads, and emitted FuzzySku records. Operator can see, but not edit, parser state. | shipped (commit `492f8ee`) |
| L4 — In-memory edit + before/after preview | Page hosts an editor (Monaco-equivalent JSONC editor) that re-runs the affected sample rows server-side without persisting. Highlighted diffs in the rendered FuzzySku columns. "Apply to ALL affected rows" expands sample to full population via paginated API. | shipped per-listing slice (commit `8824701`); full-population diff sweep still pending. |
| L5 — Embedded LLM chat panel + git commit-and-push | Chat panel calls Bedrock-mantle through the same gateway as `reviewSentimentGate.ts`. Prompt includes the current parser config, dialect contract, and the payloads exhibiting the operator-described bug. Model returns a structured JSONC patch + rationale. Apply button hits `POST /api/config/parsing/litalerts/<competitor>/commit`, which clones `helios-parser-configs` master into a per-request working dir, applies the patch, runs scoped goldens, commits, pushes, and waits for the loader to re-reflect the new SHA in `getStatus()`. Cutover from shadow to authoritative happens at the end of this phase. | shipped (chat in `492f8ee`; commit-and-push via `POST /apply-config` in `bd37cd9`; goldens enforced by `applyLitalertsTenantConfig`). |

## L1 surface — `litalerts-v1` dialect contract

Per parsekit's `UseCaseContract<T>` split, the dialect is purely
syntax. The use-case contract owns the output schema and semantic
validator. For LitAlerts the output type is **`FuzzyVariantDescriptor`**
(NOT `ParsedProductName` — see parsekit DESIGN_v1 §5.litalerts-v1),
with at minimum:

```ts
interface FuzzyVariantDescriptor {
  brand: string                  // canonicalized brand name
  productLine: string | null     // e.g. "Select" within "Curaleaf Select"
  variantName: string | null     // strain or flavor, when present
  category: Category             // flower | preroll | vape | edible | …
  packCount: number              // default 1
  unitSize: { value: number; unit: 'g' | 'mg' | 'mL' | 'ea' }
  totalSize: { value: number; unit: 'g' | 'mg' | 'mL' | 'ea' }
  prevalence: 'live' | 'cured' | 'rosin' | 'distillate' | null
  searchTerm: string | null
}
```

The dialect pack ships with the transforms LitAlerts actually needs,
reusing the METRC ones where possible and adding LitAlerts-specific
ones (e.g. pack-size math is more load-bearing here than in METRC).

## L2 surface — per-competitor configs + shadow mode

The NY competitor inventory currently consumed lives in the LitAlerts
partner worker (see
[`helios/src/worker/litalerts/`](../../../helios/src/worker/litalerts/))
and the `litalerts_competitor_observations` table. L2 produces one
`parsers/<competitorId>.jsonc` per active competitor, with a golden
corpus drawn from the last N days of observations.

Shadow mode runs the new parser next to the legacy one. The diff is
logged to a `litalerts_parsekit_reverse_shadow_events` table modeled
on
[`parsekit_reverse_shadow_events`](../../../helios/src/server/db/schema/parsekitReverseShadowEvents.sql)
so the existing review patterns transfer. The flag flips to
authoritative at the end of L5, not L2.

## L3 surface — read-only review page

`/config/parsing/litalerts` mirrors
[`ConfigParsingPendingPurchasesPage.tsx`](../../../helios/src/client/routes/config/ConfigParsingPendingPurchasesPage.tsx)
structure:

- Default-visible: per-competitor table with one row per competitor,
  badges for last-load status, mismatch counts (1h / 24h / all-time),
  and a click-to-expand area showing the recent payload sample + the
  emitted FuzzySku records side-by-side.
- Collapsed by default (`<details>`): methodology, parsekit release
  metadata, shadow-mode caveats, regeneration timestamps. Per
  `helios/AGENTS.md`, prose and provenance belong inside the
  `<details>` so the reviewer never has to scroll past it.

The backing API is
`GET /api/config/parsing/litalerts?competitor=<id>&limit=N`. It calls
`registry.getStatus()` for load state and
`loadRecentLitalertsParseEvents(competitorId, N)` for the sample.

## L4 surface — in-memory edits + before/after

Editing the config in the panel does not write to git. The page POSTs
the edited JSONC to
`POST /api/config/parsing/litalerts/<competitor>/preview`, which:

1. Validates the JSONC against the dialect's Zod shape schema.
2. Compiles the parser in an isolated parsekit generation (no swap).
3. Re-parses the on-screen sample.
4. Returns `{ before: FuzzyVariantDescriptor[], after:
   FuzzyVariantDescriptor[], diffs: FieldDiff[] }`.

"Apply to ALL affected rows" hits the same preview API but with the
full corpus paginated; the page streams results into the same diff
table. This is intentionally a separate call so the reviewer pays the
latency only when they ask for it.

## L5 surface — LLM chat panel + commit-and-push

Chat lives in a right-rail panel of `/config/parsing/litalerts`. The
prompt envelope:

- **System / contract:** the dialect JSONC + the use-case
  `FuzzyVariantDescriptor` schema + the available transform registry.
- **Tool surface for the model:** a JSON-mode response schema
  (`{ rationale: string, jsoncPatch: string, goldensToAdd: Golden[] }`)
  so we never have to parse free-form text.
- **Examples:** the operator-visible sample payloads from the current
  competitor row + the corresponding before-parse outputs.
- **Operator prompt:** the natural-language description of the
  inadequacy.

Apply path:

```
POST /api/config/parsing/litalerts/<competitor>/commit
  { jsoncPatch, goldensToAdd, commitMessage }
```

server-side:

1. Clone `helios-parser-configs` master into a per-request tempdir
   (the existing `gitMirror` cache is read-only for the loader; we
   need a fresh worktree to write into).
2. Apply the patch to
   `use-cases/litalerts/parsers/<competitorId>.jsonc`. Append
   `goldensToAdd` to `goldens/<competitorId>/llm-suggested.json`.
3. Bump `release.json`.
4. Compile + run goldens locally.
5. `git commit -m "<commitMessage>" --author "<operator>"` and
   `git push origin master`.
6. Poll `parserRegistry.getStatus()` until it advances past the new
   SHA (with a 30s upper bound and a `page-dave -p 5` on timeout).
7. Return the new SHA to the SPA, which then re-runs the preview
   to confirm the visible sample now parses as expected.

No auto-apply. The operator must click Apply explicitly after
reviewing the diff.

## Cross-cutting concerns

- **Auth.** Mutating endpoints (`/preview`, `/commit`) require
  `editor` role via
  [`requireSessionUser`](../../../helios/src/server/auth/requireSession.js).
- **Page layout.** Follow
  [`helios/AGENTS.md`](../../../helios/AGENTS.md)'s "Optimize the page
  for reviewer efficiency" rule — the parser status, the sample row
  comparison, and the chat input are above the fold; methodology /
  release SHA / shadow caveats / model rationale archive collapse
  into `<details>` blocks.
- **Disabled competitors.** Per
  [`helios/AGENTS.md`](../../../helios/AGENTS.md)'s Sweed
  disabled/DEAD rule, competitors flagged `DEAD-…` in our records
  must be filtered out of the page list and any sample-loading
  query.
- **Page-dave on loader failure.** Reuse the existing
  parser-registry page-dave path
  ([`bootstrap.ts`](../../../helios/src/lib/parsekit/node/bootstrap.ts))
  for `litalerts-v1` reload failures. No new pager wiring.
- **Cross-repo coupling.** Changes that land here MUST be paired with
  the corresponding `helios-parser-configs` PR. The `helios-prep`
  systemd unit on `vps-nixos-3` already does a `git pull` of master
  on restart but does NOT clone `helios-parser-configs`; that
  continues to be managed by `gitMirror` at runtime. See the
  "Deploying changes" section of [`AGENTS.md`](../../../AGENTS.md).

## Open questions

These are NOT blockers for L1, but need answers before L5:

1. **Configs-repo write credentials in helios.** Today only humans
   push to `helios-parser-configs`. L5 needs a deploy key (or a
   GitHub App installation) scoped to that repo, mounted into the
   helios server. Reuse `~/.secret/...` convention; pick a path.
2. **Concurrency under chat.** If two operators chat on two
   different competitors simultaneously and both click Apply, the
   second push will race. Acceptable behavior: rebase + replay in
   the per-request worktree, surface a banner if the goldens fail
   after rebase.
3. **LLM prompt budget.** Curaleaf has thousands of distinct SKUs;
   the prompt MUST window down to a representative sample + the
   operator-cited bad rows. Decide cap (probably 50 rows or 8k
   tokens, whichever is smaller).
4. **Versioning for `litalerts-v1`.** Parsekit identity is
   `{ tenantId, useCase }` with dialect as a versioned ref. Bumping
   the dialect from `@1` to `@2` should be a deliberate human PR,
   not something the chat panel can do. The chat surface in L5 must
   refuse patches that touch `dialects/`; it only edits
   `parsers/<id>.jsonc` and `goldens/<id>/…`.

## Definition of done for the epic

- A reviewer can open `/config/parsing/litalerts` on mobile, see the
  competitor list with current parser status, expand a row, see the
  payload + FuzzySku comparison, describe a problem in the chat,
  preview the LLM's proposed diff against the visible sample and the
  full affected population, click Apply, and observe the SPA
  reflect the new SHA within ~30 seconds — all without leaving the
  page or shelling out to git.
- Shadow-mode diffs over the previous 7 days show <5% disagreement
  for every active NY competitor, with every remaining disagreement
  having a recorded explanation in `litalerts_parsekit_reverse_shadow_events`.
- `helios-parser-configs/use-cases/litalerts/` contains a parser
  config + goldens per active NY competitor, all loading green per
  `getParserRegistry().getStatus()`.
- The legacy ad-hoc LitAlerts SKU parsing is removed (or kept
  behind a kill-switch env var for one release window per the
  parsekit migration discipline).

## Next concrete step

L1 is the unblocker for everything else. The next worker should:

1. Open a worktree on `helios-parser-configs`.
2. Author `use-cases/litalerts/dialects/litalerts-v1@1.jsonc`
   carrying the `FuzzyVariantDescriptor` output contract.
3. Seed `use-cases/litalerts/parsers/<one-competitor>.jsonc` for the
   highest-volume NY competitor.
4. Capture ~20 real payloads from
   `litalerts_competitor_observations` into
   `use-cases/litalerts/goldens/<competitor>/seed.json`.
5. Bump `release.json` and push.
6. On the helios side, register `litalerts` as a known use-case in
   `parserRegistry` (no SPA changes yet) and verify the loader picks
   it up green via `getParserRegistry().getStatus()` on
   `vps-nixos-3`.

That work is small enough to be its own task once an issue-level
breakdown is filed; this document exists so the breakdown has
something to refer to.
