# parsekit Epic Plan

Consolidated design for the FreshlyBakedNYC parser-combinator module ("parsekit") that replaces regex-based parsing of third-party data (METRC pending-purchase product names today; LitAlerts SKUs and competitor ecom pages later).

The unconsolidated design is in [`DESIGN_v1.md`](./DESIGN_v1.md); the adversarial critique is in [`REVIEW_v1.md`](./REVIEW_v1.md). This document is the consolidated source of truth — where it disagrees with DESIGN_v1, this document wins.

## Default decisions (final)

| Topic | Default |
|---|---|
| Source format | JSONC declarative AST. No YAML, no custom surface DSL in v1. |
| Parser library | `arcsecond`. Re-evaluate only if left-recursion / left-factor / large-grammar perf becomes a real pain. |
| Runtime identity | `ParserScope = { tenantId, useCase }`. `dialect` is an imported reference with `{ id, version }`, NOT part of identity. |
| Output contract | `UseCaseContract<T>` owns `outputSchema` (Zod) + `semanticValidate`. Dialects are syntax libraries only. |
| Reload unit | Whole-release by commit SHA via a `release.json` manifest. fs.watch + git poll trigger; manifest defines truth. |
| Reload safety | Stage in temp dir → compile dependency closure → run scoped goldens → atomic generation pointer swap with in-flight refcount. |
| Learning loop | Workers ENQUEUE proposals into `parsekit_learning_candidates` DB table. A single-writer **reconciler** leases, rebases on latest HEAD, revalidates, and pushes. No worker writes git directly. |
| Auto-merge policy | Only narrow edits (`addGolden`, exact literal `addRule` with one golden, `setRulePriority` for ID already in repo). Broad edits (macros, dialect, detect, replaceSubtree) require human PR review. |
| Canonical-edit format | Typed AST patches with ID-anchored paths. Helpers for common ops; `replaceSubtree` escape hatch under policy. |
| Zod placement | Config load: JSONC → Zod (shape). Parse runtime: arcsecond → captures → projection → transforms → Zod (output shape) → semantic validator. |
| Transformer registry | `{ name, version, args }` with per-transform Zod arg schema + determinism tests. |
| Migration risk control | **Shadow / parity mode**. New parser runs alongside legacy; outputs diffed and logged. Cutover gated on parity threshold + corpus replay. Kill-switch env var keeps legacy fallback for one release window post-cutover. |
| Browser scope (v1) | Read-only review UI loading compiled snapshot JSON. No JSONC authoring, no git, no LLM. Authoring stays in the configs repo + reconciler. |
| Paging | `page-dave -p 5 -t '...' '...'` via `spawn`. Throttle on `(tenantId, headSha, errorHash)` with cooldown. Page only when a release is stuck or a production parser becomes unavailable, NOT on every per-tenant validation failure that leaves a prior snapshot serving. |
| Configs repo | New repo `github.com/FreshlyBakedNYC/parsekit-configs`. Deployed to box via `self-deploy` (full) or `self-deploy-configs` (fast). Watch location: `/var/lib/parsekit-configs/current` (symlink swapped by deploy). |
| Security floor | Acyclic ref/macro graph; bounded `repeat` and `sepBy` (max required); max AST depth + choice fanout; input length cap; per-parse step budget; transform allowlist with arg schemas; projection allowlist (no fields outside output schema); LLM prompt receives raw input only as JSON data; no regex primitive in v1. |

## System overview

```text
╭──────────────────────────────────────────────────────╮
│ github.com/FreshlyBakedNYC/parsekit-configs          │
│   release.json (manifest)                            │
│   use-cases/{pending-purchases,litalerts,ecom}/      │
│     dialects/<id>@<version>.jsonc                    │
│     parsers/<tenantId>.jsonc                         │
│     shared/<macro|token|transform-ref>.jsonc         │
╰────────────────────────┬─────────────────────────────╯
                         │ self-deploy-configs (git fetch + symlink swap)
                         ▼
╭──────────────────────────────────────────────────────╮
│ /var/lib/parsekit-configs/current → <sha-staged-dir> │
╰────────────────────────┬─────────────────────────────╯
                         │ fs.watch (hint) + git poll
                         ▼
╭──────────────────────────────────────────────────────╮
│ parsekit/node ReleaseLoader                          │
│   stage → parse JSONC → Zod shape → compile closure  │
│   → scoped goldens → swap generation pointer         │
╰────────────────────────┬─────────────────────────────╯
                         │ parse(scope, input, ctx)
                         ▼
╭──────────────────────────────────────────────────────╮
│ parsekit core (isomorphic)                           │
│   arcsecond run → captures → project → transforms    │
│   → output Zod → useCase.semanticValidate            │
╰──┬──────────────────────────────┬────────────────────╯
   │ no-match                     │ match
   ▼                              ▼
╭──────────────────────────╮   ╭──────────────────────╮
│ DB: parsekit_learning_   │   │ Helios worker        │
│     candidates (queue)   │   │ ParsedProductName    │
╰────┬─────────────────────╯   ╰──────────────────────╯
     │ lease
     ▼
╭──────────────────────────────────────────────────────╮
│ parsekit/reconciler (single writer)                  │
│   git pull → propose via Bedrock-Mantle → apply      │
│   typed patch → validate + scoped goldens → if       │
│   narrow-auto-merge: commit+push; else: open PR      │
╰────────────────────────┬─────────────────────────────╯
                         │ page-dave -p 5 on stuck/unavailable
                         ▼
                  ╭──────────────╮
                  │  page-dave   │
                  ╰──────────────╯
```

## Repo layout (`FreshlyBakedNYC/parsekit-configs`)

```text
parsekit-configs/
  release.json                # { sha, schemaVersion, parsers: [...], dialects: [...] }
  use-cases/
    pending-purchases/
      dialects/
        metrc-v1.jsonc
      parsers/
        curaleaf.jsonc
        bytes.jsonc
        outrankd.jsonc
        the-gram.jsonc
        moonlit.jsonc
        smartbud.jsonc
        herb.jsonc
        jennys.jsonc
        posh-puff.jsonc
        layup.jsonc
        cannabals.jsonc
        hr-botanical.jsonc
    litalerts/
      dialects/
      parsers/
    ecom/
      dialects/
      parsers/
```

The repo is **data-only**. Dialect packs (token/macro/transform implementations) live in parsekit library code, referenced by `{ id, version }`. `release.json` is the source of truth for "which files belong to this release" and is written **last** by the deploy step.

## TypeScript surface (final)

### Isomorphic core (`@freshly-baked/parsekit`)

```ts
type Expr =
  | { kind: 'lit'; value: string; caseInsensitive?: boolean }
  | { kind: 'token'; token: string }
  | { kind: 'seq'; items: Expr[] }
  | { kind: 'choice'; items: Expr[] }
  | { kind: 'capture'; name: string; expr: Expr }
  | { kind: 'optional'; expr: Expr }
  | { kind: 'repeat'; expr: Expr; min: number; max: number }       // max required
  | { kind: 'between'; expr: Expr; left: Expr; right: Expr }
  | { kind: 'sepBy'; expr: Expr; sep: Expr; min?: number; max?: number }
  | { kind: 'ref'; target: string }
  | { kind: 'macro'; target: string; args?: Record<string, JsonValue> }

interface TenantParserConfig {
  configVersion: 1
  parserId: string
  scope: { tenantId: string; useCase: string }
  dialectRef: { id: string; version: number }
  detect: { prefixes?: string[]; predicates?: { name: string; args?: JsonValue }[] }
  rules: Rule[]
}

interface Rule {
  id: string
  priority: number
  enabled?: boolean
  parser: Expr
  project: Record<string, ValueExpr>
  transforms?: TransformCall[]
  goldens: GoldenCase[]
  notes?: string[]
}

type GoldenCase =
  | { kind: 'match'; id: string; input: string; expected: unknown }
  | { kind: 'no_match'; id: string; input: string }

type ValueExpr =
  | { from: string; transforms?: TransformCall[] }
  | { literal: JsonValue }

interface TransformCall {
  name: string
  version: number
  args?: Record<string, JsonValue>
}

interface DialectPack {
  id: string
  version: number
  tokens: Record<string, Expr | ArcsecondParser<unknown>>
  macros: Record<string, MacroDef>
  transforms: Record<string, TransformDef<unknown>>
}

interface UseCaseContract<T> {
  useCase: string
  outputSchema: z.ZodType<T>
  semanticValidate: (value: T) => ValidationIssue[]
}

export function compileRelease(input: {
  manifest: ReleaseManifest
  dialects: DialectPack[]
  parsers: TenantParserConfig[]
  contracts: UseCaseContract<unknown>[]
}): CompiledRelease

export function parseWithRelease<T>(
  release: CompiledRelease,
  scope: { tenantId: string; useCase: string },
  input: string,
  context?: unknown,
): ParseResult<T>

export function applyCanonicalEdits(
  parsers: TenantParserConfig[],
  edits: CanonicalEdit[],
): CanonicalEditResult

export function staticSafetyCheck(parser: TenantParserConfig, dialect: DialectPack): SafetyReport
```

### Node-only (`@freshly-baked/parsekit-node`)

```ts
export function loadRepoFromPath(rootPath: string): Promise<LoadedRepo>
export function createReleaseLoader(opts: LoaderOptions): Promise<ReleaseLoader>
export function commitAndPushRepo(rootPath: string, message: string): Promise<GitCommitResult>
export function createPageDavePager(env?: { topic?: string }): Pager
```

### Helios METRC wrapper

```ts
export function parsePendingPurchaseProductName(input: {
  rawName: string
  tenantHint?: string
  distributorNames?: string[]
}): ParseResult<ParsedProductName>
```

## CanonicalEdit (final)

```ts
type CanonicalEdit =
  | { op: 'upsertRule'; parserId: string; rule: Rule }
  | { op: 'removeRule'; parserId: string; ruleId: string }
  | { op: 'patchExpr'; parserId: string; ruleId: string; path: ExprPath; value: Expr }
  | { op: 'patchProjection'; parserId: string; ruleId: string; value: Record<string, ValueExpr> }
  | { op: 'patchTransform'; parserId: string; ruleId: string; index: number; value: TransformCall }
  | { op: 'addGolden'; parserId: string; ruleId: string; golden: GoldenCase }
  | { op: 'upsertMacro'; dialectId: string; macroId: string; value: MacroDef }
  | { op: 'upsertToken'; dialectId: string; tokenId: string; value: TokenDef }
  | { op: 'setDetect'; parserId: string; detect: DetectSpec }
  | { op: 'setRulePriority'; parserId: string; ruleId: string; priority: number }
  | { op: 'replaceSubtree'; jsonPath: string; value: unknown; reason: string }     // policy-gated
```

Auto-merge whitelist (v1): `addGolden`, `setRulePriority`, and `upsertRule` only when the rule's `parser.kind` is `lit` (pure exact-name rule) with at least one matching golden. Everything else opens a PR.

## Failure-isolation contract

- A release manifest with any unresolvable reference (missing tenant, missing dialect version, missing macro/token/transform) is **invalid** and refused; previous generation keeps serving for all tenants.
- A release with valid manifest but per-tenant compile/golden failures: that tenant keeps its prior compiled parser from the previous generation; siblings advance to the new generation.
- A release stuck on the previous generation for >15 minutes (configurable) pages P5.
- Per-tenant validation failures on hot reload page P5 only if the tenant transitions to "unavailable" (no prior generation to fall back to).

## METRC migration (consolidated)

1. **Identity + schema + repo skeleton** committed to `parsekit-configs`.
2. **Core compiler + static safety verifier** in `helios/src/lib/parsekit/`.
3. **Release loader + atomic generation swap** in `helios/src/lib/parsekit/node/`.
4. **`metrc-v1` dialect pack** with tokens (`dash`, `pipe`, `int`, `decimal`, `grams`, `milligrams`, `prevalenceSuffix`, etc.), macros (`brand-dash-group-dash-family-dash-size`, etc.), and the 12 starter transforms.
5. **Test harness**: positive goldens, negative `no_match`, collision scan, replay corpus runner, differential compare vs current `parseProductName`.
6. **Port 12 hardcoded parsers** to JSONC tenant parsers in the configs repo with full goldens seeded from current behavior.
7. **Shadow mode**: `parsePendingPurchaseProductName` runs new parser alongside legacy; diffs logged; no behavior change yet.
8. **Cutover**: switch primary to parsekit; legacy retained behind `PARSEKIT_LEGACY_FALLBACK=1` env for one release window.
9. **DB**: add `parser_combinator` rule kind; freeze writes to `regex`/`template`; migrate active rules behind reconciler; add `parsekit_learning_candidates` table.
10. **Reconciler service**: queue lease + rebase + apply patch + scoped goldens + push (narrow) or PR (broad).
11. **LLM gap-fill loop**: wired only after reconciler + shadow parity stable.
12. **Read-only browser review UI**: snapshot loader + parse trace explorer.

## Forward-compat for use-cases 2 & 3

The identity model `{ tenantId, useCase }` and the dialect/contract split mean LitAlerts and ecom dialects ship as separate dialect packs + use-case contracts without touching METRC code. Adapters (HTML/JSON-LD extraction) live outside parsekit and feed strings in.

## AST drift log (v1 surface, source of truth)

The AST that ships in v1 has drifted from the snippet in §"TypeScript
surface (final)" above as implementation hit real tenants. The
authoritative shape lives in
[`helios/src/lib/parsekit/types.ts`](../../../helios/src/lib/parsekit/types.ts).
Changes accepted into the v1 surface:

| Addition | Why | Status |
|---|---|---|
| `consumeUntil(terminator, minLen?)` | Variable-length cultivar text terminated by a lookahead (Moonlit, Jenny's, Posh Puff). Built on arcsecond `everyCharUntil`. | shipped |
| `captureMany(name, expr)` + parallel `listCaptures: Record<string,string[]>` runtime map + `ValueExpr.fromList` projection source | Variable-length modifier-token bag with optional inline pack token (Curaleaf, Cannabals Gummy Brick). Constrained: may only wrap `repeat`/`sepBy`; no nested named captures inside. | planned (Phase 6 hardening) |

These are the *last* intentional v1 AST additions before configs
externalize to the parsekit-configs repo. Any further changes after
Phase 6 require bumping `configVersion` and migrating tenant configs.

### Stabilization invariants (Phase 4.5 — already in code)

- `compileParser` refuses to build when `config.dialectRef.{id,version}`
  does not match the supplied dialect, or when `config.scope.useCase`
  does not match the supplied contract's `useCase`. The static safety
  verifier reports these as `dialect_ref_mismatch` /
  `use_case_mismatch` issues for batch validation.
- `TransformDef.version` is now mandatory; the verifier rejects calls
  whose `TransformCall.version` does not match the dialect-shipped
  version (`transform_version_mismatch`). This makes version pinning
  enforceable, not decorative.
- Verifier rejects `repeat`/`sepBy` whose body (or `sepBy.sep`) can
  match empty input — a classic parser footgun. Detection is a
  conservative `canMatchEmpty(expr)` walk; opaque tokens are assumed
  non-empty except the well-known `optWs`.
- `parseIntStrict` rejects strings containing anything other than
  digits (so `"10PK"` no longer silently becomes `10`).

## Open questions (pending operator input)

These are NOT blockers for implementation but should be confirmed before reconciler + LLM gap-fill go live:

1. Direct-push vs PR-only for narrow auto-merge edits? (Default: direct push for `addGolden` + exact-literal `addRule`; PR for everything else.)
2. Tenant auto-creation? (Default: manual only in v1; reconciler refuses to create new parser files.)
3. Replay corpus size at cutover gate? (Default: last 90d of pending-purchase rows + curated unit-test corpus.)
4. Reconciler topology — one box, one process, leader-elected, or external service? (Default: a single helios worker job with a singleton lease, runs only on the primary box.)
