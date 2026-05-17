# parsekit Design for FreshlyBakedNYC

*Source: oracle design pass, 2026-05-17. To be critiqued in REVIEW_v1.md, then consolidated to DESIGN.md.*

## Default decisions

| Topic | Default |
|---|---|
| DSL | **JSONC** files containing a declarative JSON AST; no v1 custom text DSL |
| Arcsecond | **Keep arcsecond**; wrap it with a small typed compiler layer |
| LLM combinator vocab | **Structured JSON-mode proposal schema** + a generated dialect reference + a few-shot examples |
| Partial progress durability | **Commit and push one validated patch at a time** |
| Transformers | **Named pure registry** with a METRC-focused starter set |
| Hot reload safety | **`fs.watch` as a hint + `git pull` polling + debounce + compile-then-swap immutable snapshots** |
| Zod placement | **Config load:** JSONC → Zod. **Parse runtime:** arcsecond → projection/transforms → Zod → semantic validator |
| Canonical patch type | **Domain-specific canonical edits**, not raw RFC-6902 as the public surface |
| Failure isolation | **Per-tenant snapshots**; a broken tenant never takes down others |

---

## 1. Goals & non-goals

### Goals

1. Replace the current hardcoded and regex-heavy pending-purchase name parsing with a **data-driven parser-combinator system** built on `arcsecond`.
2. Make parsing behavior **Git-backed, reviewable, hot-reloadable, and testable** via a separate config repo: `github.com/FreshlyBakedNYC/parsekit-configs`.
3. Keep the parser core **isomorphic** so the same compile/validate/parse logic runs in Node and in a browser-based review/tuning UI.
4. Support **dialect composition**:
   - core combinators
   - per-domain token/transform packs
   - per-tenant config trees
5. Treat every rule as **auditable and regression-tested** by requiring embedded goldens.
6. Support a **live-learning loop** for METRC where unmatched names can produce a safe patch, validate, reload, and persist incremental progress.
7. Preserve existing operational needs in Helios:
   - keep brand profiles, aliases, and observations
   - page Dave on reload failures
   - hard cutover, no feature flag

### Non-goals

1. Not a general NLP parser framework.
2. Not a place for arbitrary JavaScript in config files.
3. Not a PEG/packrat engine with advanced ambiguity resolution in v1.
4. Not a general HTML crawler. For ecom use-cases, parsekit consumes normalized candidate strings produced by adapters.
5. Not a full semantic ontology validator in Zod. Zod is for **shape/type validation**; semantic checks stay in dialect validators.
6. Not a custom config language in v1. That is unnecessary complexity before the first METRC migration lands.

---

## 2. System overview with a plain-text rounded-corner box diagram

`parsekit` has three layers:

- **Core runtime**: compiles JSONC config AST into arcsecond parsers and executes them.
- **Node watch-loader**: loads a deployed clone, watches for changes, validates, compiles, and hot-swaps snapshots.
- **Learning/mutation loop**: on no-match, proposes a patch, validates it, runs goldens, commits it, and reloads.

```text
╭──────────────────────────────────────────────╮
│ github.com/FreshlyBakedNYC/parsekit-configs  │
│ JSONC configs + goldens                      │
╰───────────────────────┬──────────────────────╯
                        │ deployed via self-deploy-configs
                        ▼
╭──────────────────────────────────────────────╮
│ parsekit/node watch-loader                   │
│ fs.watch + git pull poll + validate/compile  │
│ immutable per-tenant snapshots               │
╰───────────────┬───────────────────────┬──────╯
                │                       │
                │ parse(raw input)      │ reload failure
                ▼                       ▼
╭────────────────────────────────╮   ╭──────────────────────╮
│ parsekit core (isomorphic)     │   │ page-dave            │
│ arcsecond expr -> captures     │   │ P5 alerts / summary  │
│ -> transforms -> Zod ->        │   ╰──────────────────────╯
│ semantic validator             │
╰───────────────┬────────────────╯
        match   │ no-match
                ▼
╭──────────────────────────────────────────────╮
│ Bedrock-Mantle learning loop                 │
│ propose patch -> canonical-edit -> validate  │
│ -> goldens -> reparse -> commit/push         │
╰───────────────────────┬──────────────────────╯
                        │
                        └──── hot reloads updated tenant snapshot
```

### Runtime resolution order for METRC

1. **DB exact override** if retained during migration.
2. **parsekit tenant parser bundle** from the watched config snapshot.
3. **LLM gap-fill loop** on no-match.
4. **Observation capture + unresolved manual review** if still unmatched.

That order keeps the normal path fast and deterministic while still allowing live learning.

---

## 3. Configuration DSL choice + grammar

### Choice: JSONC

Use **JSONC** for all repo-authored configs.

Why JSONC over a tiny custom DSL:

- It is **easy to parse, validate, diff, canonically rewrite, and generate**.
- It works naturally with **Zod** and with **JSON-mode LLM outputs**.
- Comments and trailing commas make it readable enough for humans.
- A custom DSL would require:
  - another parser,
  - another compiler,
  - another error surface,
  - another formatter,
  - another canonical mutation engine.

That is too much surface area for v1.

### Important nuance

The source format is JSONC, but the thing being expressed is still a **parser DSL**: a small declarative AST of parser nodes, projections, and transform calls. So we get an ergonomic middle ground:

- **No freeform regex authoring**
- **No arbitrary code**
- **Still compact enough for humans and LLMs**

### Top-level grammar

```ebnf
RepoManifest   ::= {
  "schemaVersion": number,
  "useCases": object
}

TenantConfig   ::= {
  "id": string,
  "useCase": string,
  "dialect": string,
  "detect"?: DetectSpec,
  "rules": Rule[]
}

Rule           ::= {
  "id": string,
  "priority": number,
  "enabled"?: boolean,
  "leadIns"?: string[],
  "parser": Expr,
  "project": Projection,
  "transforms"?: TransformCall[],
  "goldens": Golden[],
  "notes"?: string
}

Expr           ::= Lit
                 | TokenRef
                 | Seq
                 | Choice
                 | Capture
                 | Optional
                 | Repeat
                 | Between
                 | SepBy
                 | Ref
                 | Macro

Projection     ::= { fieldName: ValueExpr, ... }

ValueExpr      ::= { "from": string, "transforms"?: TransformCall[] }
                 | { "literal": JsonValue }

TransformCall  ::= { "name": string, "args"?: object }

Golden         ::= { "id": string, "input": string, "expect": object }
                 | { "id": string, "input": string, "noMatch": true }
```

### Minimal expression vocabulary

```jsonc
{
  "op": "seq",
  "items": [
    { "op": "lit", "value": "Bytes", "ci": true },
    { "op": "token", "name": "dash" },
    { "op": "capture", "name": "group", "expr": { "op": "token", "name": "textUntilDash" } },
    { "op": "token", "name": "dash" },
    { "op": "lit", "value": "Edibles", "ci": true },
    { "op": "token", "name": "dash" },
    { "op": "capture", "name": "packCount", "expr": { "op": "token", "name": "int" } }
  ]
}
```

### Example tenant rule

```jsonc
{
  "id": "bytes",
  "useCase": "pending-purchases",
  "dialect": "metrc-v1",
  "detect": {
    "prefixes": ["bytes"]
  },
  "rules": [
    {
      "id": "bytes-edibles-v1",
      "priority": 100,
      "leadIns": ["bytes -"],
      "parser": {
        "op": "macro",
        "name": "metrc.brand-dash-group-dash-family-dash-count",
        "args": {
          "brand": "Bytes",
          "family": "Edibles"
        }
      },
      "project": {
        "brand": { "literal": "Bytes" },
        "category": { "literal": "Edibles" },
        "subcategory": { "literal": "Chews/Gummies" },
        "groupName": { "from": "group", "transforms": [{ "name": "cleanCultivar" }] },
        "packCount": { "from": "packCount" },
        "size": { "literal": "10mg" },
        "strainName": { "literal": "" },
        "prevalence": { "literal": null },
        "searchTerm": { "from": "group", "transforms": [{ "name": "cleanCultivar" }] }
      },
      "transforms": [
        { "name": "inferVariantTab" },
        { "name": "inferVariantName" }
      ],
      "goldens": [
        {
          "id": "g1",
          "input": "Bytes - Sour Watermelon - Edibles - 10",
          "expect": {
            "brand": "Bytes",
            "category": "Edibles",
            "subcategory": "Chews/Gummies",
            "groupName": "Sour Watermelon",
            "variantName": "Bytes Sour Watermelon 10x 10mg",
            "variantTab": "10x 10mg",
            "size": "10mg",
            "packCount": 10,
            "strainName": "",
            "prevalence": null,
            "searchTerm": "Sour Watermelon"
          }
        }
      ]
    }
  ]
}
```

---

## 4. Combinator library (atoms + combinators + types)

### Why `arcsecond`

`arcsecond` is the right default for v1 because it is:

- TypeScript-friendly
- small and understandable
- isomorphic
- expressive enough for lexerless product-name parsing
- easy to wrap behind a stricter API

I would **not swap it now**.

I would only reconsider if one of these becomes true:

- large ambiguous grammars cause meaningful performance problems
- we need left recursion
- we need industrial parser diagnostics/error recovery
- configs evolve into a full programming language

At that point, a PEG or parser-generator approach would be worth revisiting. Today, it is unnecessary.

### Core atoms

These should be the only low-level building blocks tenant configs see, either directly or through macros.

- `lit(value, ci?)`
- `token(name)` for named dialect tokens
- `int`
- `decimal`
- `grams`
- `milligrams`
- `word`
- `wordsUntil(delimiter)`
- punctuation tokens: `dash`, `slash`, `pipe`, `lparen`, `rparen`
- whitespace helpers: `ws`, `optWs`
- `start`, `end`

Internal implementation may use tiny regex atoms inside the library for primitives like decimals or unit tokens, but **arbitrary config-authored regex is not exposed**.

### Core combinators

These compile to arcsecond primitives such as `sequenceOf`, `choice`, `possibly`, `many`, `between`, `sepBy`, and `recursiveParser`.

- `seq`
- `choice`
- `capture`
- `optional`
- `repeat`
- `between`
- `sepBy`
- `ref`
- `macro`

### Core types

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

export interface TransformCall {
  name: string
  args?: Record<string, JsonValue>
}

export type Expr =
  | { op: 'lit'; value: string; ci?: boolean }
  | { op: 'token'; name: string }
  | { op: 'seq'; items: Expr[] }
  | { op: 'choice'; options: Expr[] }
  | { op: 'capture'; name: string; expr: Expr }
  | { op: 'optional'; expr: Expr }
  | { op: 'repeat'; expr: Expr; min?: number; max?: number }
  | { op: 'between'; left: Expr; expr: Expr; right: Expr }
  | { op: 'sepBy'; expr: Expr; sep: Expr }
  | { op: 'ref'; name: string }
  | { op: 'macro'; name: string; args?: Record<string, JsonValue> }

export interface DialectPack<TOutput, TContext = unknown> {
  id: string
  outputSchema: z.ZodType<TOutput>
  semanticValidate(output: TOutput): string[]
  tokens: Record<string, Expr | ArcsecondParser<unknown>>
  transforms: Record<string, Transformer<TOutput, TContext>>
  macros: Record<string, MacroExpander>
}
```

### Parse pipeline

The runtime path should be:

1. raw input string
2. arcsecond parser run
3. capture map
4. projection into candidate output
5. post-extract transforms
6. **Zod parse**
7. semantic validator
8. success or parse fail

That is the right place for Zod: **after parse, before acceptance**. If Zod fails, it is a parse failure.

---

## 5. Per-use-case dialect layers ("parser combinator combinators")

The composition model should be:

1. **Core**: generic parser AST + compiler + base combinators
2. **Dialect pack**: named tokens, named transforms, named macros, output schema
3. **Tenant tree**: rules, priorities, goldens, aliases/detection metadata

### `metrc-v1` dialect pack

This is the first real consumer and should ship with:

- output schema matching current worker expectations, including `searchTerm`
- current semantic checks from `normalizeAndValidateParsedProductName`
- tokens for:
  - Curaleaf type prefixes
  - pack counts
  - gram/mg sizes
  - family labels (`Flower`, `Disposable Vape`, `Infused Preroll`, etc.)
  - prevalence suffixes `(I|S|H)`
- macros for common layouts:
  - `brand-dash-group-dash-family-dash-size`
  - `brand-dash-group-dash-family-dash-count`
  - `curaleaf-hyphen-series`
  - `family-tail-size`
- transforms for METRC normalization

### Starter transformer registry for METRC

These cover the existing 12 parsers well:

1. `normalizeBrand`
2. `cleanCultivar`
3. `normalizeSizeText`
4. `unitSizeFromTotalSizeAndPackCount`
5. `unitMgFromTotalMgAndPackCount`
6. `prevalenceFromSuffix`
7. `defaultStrainNameFromGroup`
8. `blankStrainForCategory`
9. `inferVariantTab`
10. `inferVariantName`
11. `defaultSearchTermFromGroup`
12. `appendGroupSuffix`

That is slightly more than the minimum, but these are exactly the kinds of operations already embedded in the current parser functions.

### `litalerts-v1` dialect pack

This should emit `FuzzyVariantDescriptor`, not `ParsedProductName`.

Key differences:

- output schema is different
- pack/total-size math is more important
- normalization is more catalog-matching oriented than customer-facing naming
- post-extract transformers matter more than exact literal parsing

### `ecom-v1` dialect pack

This should assume the input is already normalized into candidate text fields like:

- page title
- JSON-LD product name
- breadcrumb leaf
- variant labels
- sitemap title

The core parser stays string-based. HTML parsing itself belongs in an adapter layer outside parsekit.

---

## 6. Watch-loader runtime (Node)

Node-only functionality lives under **`parsekit/node`**.

### Responsibilities

- load a deployed clone from a filesystem path
- parse JSONC
- validate configs
- compile affected tenants
- run goldens
- hot-swap successful snapshots
- watch local changes with `fs.watch`
- recover missed changes with a periodic `git pull --ff-only`
- page on load/reload failures

### Recommended API

```ts
const runtime = await createWatchLoader({
  rootPath: '/opt/parsekit-configs',
  gitPollMs: 60_000,
  debounceMs: 300,
  pager: createPageDavePager(),
})

const result = runtime.parse({
  useCase: 'pending-purchases',
  tenantHint: 'curaleaf',
  input: rawName,
  context: { distributorNames, manifestHints },
})
```

### Hot-reload safety defaults

Use this sequence on every detected change:

1. **Debounce** change bursts for ~300ms.
2. Build the **affected tenant set** from the changed files.
3. Read files into an in-memory staged tree.
4. Parse JSONC and run Zod validation.
5. Compile affected tenants to immutable snapshots.
6. Run goldens for affected tenants.
7. Acquire a **single async reload mutex**.
8. Swap only successful tenant snapshots into the live map.
9. Keep prior snapshots for failed tenants.
10. Emit P5 page for failures.

### Why both `fs.watch` and `git pull` polling

`fs.watch` is fast but unreliable across deploy methods, atomic directory swaps, and missed events. Treat it as a **hint**, not truth.

The periodic `git pull --ff-only` is the recovery path and cross-node sync path.

### Concurrency model

Reads should be lock-free in practice:

- each parse call grabs the current immutable snapshot reference
- reloads build new snapshots off to the side
- swap is one pointer replacement per tenant map entry

That is simpler than trying to mutate a live engine in place.

---

## 7. Validator + golden-regression harness

Validation should happen at four levels:

### 1. Config shape validation

- JSONC parse
- Zod validation of tenant/rule/AST structure
- duplicate IDs
- unknown token/macro/transform references
- invalid priority ordering

### 2. Compile validation

- bad macro expansion
- unsupported recursion
- impossible projections
- incompatible output field types

### 3. Runtime output validation

After parse and transforms, run **Zod** on the output schema for that dialect.

For METRC, that schema is the current `ParsedProductName` shape plus `searchTerm`.

### 4. Semantic validation

Keep this separate from Zod.

For `metrc-v1`, it should preserve the current logic:

- required brand/category/size/variantTab
- positive packCount
- reject generic leaf names like bare "Vape" or bare "Gummy"
- normalize variantTab for pack vs single

### Golden harness rules

Every rule must carry its own goldens.

A golden should run through the **full tenant parser**, not only the isolated rule, because precedence conflicts are exactly what we want to catch.

The harness should verify:

- positive parse matches expected output exactly
- `noMatch` cases remain unmatched
- a new rule does not steal another rule's golden unless deliberately replacing it
- affected-tenant regression is clean before any commit or reload swap

### CLI/programmatic usage

- `validateTenant(config, dialect)`
- `runGoldens(compiledTenant)`
- `validateAffectedRepo(rootPath, changedFiles)`

For migration, add a one-time offline harness that replays historical METRC rows through:
- current hardcoded parser
- new parsekit parser
- diff report

That becomes the parity gate before hard cutover.

---

## 8. Canonical-edit / programmatic mutation library

Use a **domain-specific patch format**, not raw RFC-6902 as the public interface.

Why not RFC-6902 publicly:

- array-index paths are brittle
- comments complicate path stability
- LLMs are bad at precise JSON Pointer surgery
- stable IDs are much safer than positional edits

### Public patch model

```ts
type CanonicalEdit =
  | { op: 'addRule'; tenantId: string; afterRuleId?: string; rule: Rule }
  | { op: 'replaceRule'; tenantId: string; ruleId: string; rule: Rule }
  | { op: 'removeRule'; tenantId: string; ruleId: string }
  | { op: 'addGolden'; tenantId: string; ruleId: string; golden: Golden }
  | { op: 'upsertDetectPrefix'; tenantId: string; prefix: string }
  | { op: 'setRulePriority'; tenantId: string; ruleId: string; priority: number }
```

### Canonical-edit behavior

1. Load JSONC into AST.
2. Resolve IDs.
3. Apply domain edits.
4. Canonically sort and rewrite:
   - rules by priority desc, then ID
   - fields in stable key order
   - normalized whitespace/formatting
5. Validate affected tenants.
6. Run affected goldens.
7. Refuse write/commit if anything fails.

### Comment policy

Comments are allowed, but the canonical writer should own formatting. Do **not** promise exact comment preservation inside rewritten subtrees. Deterministic output is more important than comment fidelity.

### Browser support

The object-level mutation engine should stay isomorphic. The filesystem and git wrappers live in `parsekit/node`.

---

## 9. LLM gap-fill / live-learning loop

### Default proposal format

Use **JSON-mode constrained output** with:

- a Zod-defined proposal schema
- a generated dialect vocabulary reference
- 2–3 few-shot examples
- no tool-use in v1

This is the best simplicity/safety tradeoff.

Tool-use is unnecessary here because the safe operations are already well-bounded:
- propose edits
- add goldens
- choose rationale/confidence

### Prompt payload

For METRC no-match, send:

- failing raw product name
- tenant hint / distributor hint
- current tenant config slice
- dialect reference:
  - allowed macros
  - allowed tokens
  - allowed transforms
  - output schema summary
- nearest existing goldens/examples
- hints from manifests/free text descriptions
- instruction that generalized rules must be explainable from the raw name, not hidden context

### Learning loop

1. parsekit returns `no_match`
2. learner asks Bedrock-Mantle for a `LearningProposal`
3. parse proposal with Zod
4. canonical-edit proposal into an in-memory staged config
5. validate + run affected goldens
6. reparse the original failing input
7. if success, commit and push immediately
8. hot-reload updated tenant snapshot
9. continue through remaining unresolved rows using the new snapshot

### Partial durability default

**Commit one accepted patch at a time.**

That is the right default for use-case 1. If row 1 teaches something useful and row 2 still fails, row 1 should remain durable.

### Narrow-before-broad rule policy

The learner should prefer, in order:

1. a narrow literal rule with a golden
2. a small generalized macro-backed rule under a known tenant
3. a no-op / unresolved result

If the model cannot safely generalize, it should still be allowed to make **incremental exact progress**.

---

## 10. P5 alarm + completion paging via `page-dave -p 5 -t '...' '...'`

### P5 page triggers

Send a P5 page on:

1. initial config load failure for any required tenant
2. reload validation failure
3. reload compile failure
4. reload golden regression failure
5. live-learning commit/push failure after a validated patch
6. optional batch completion summary for manual or unattended learning runs

### Command shape

Use `spawn`, not shell interpolation.

Example failure page:

```bash
page-dave -p 5 -t 'parsekit reload failed: pending-purchases/curaleaf' \
  'repo=/opt/parsekit-configs head=abc123 kept_previous_snapshot=def456 error=golden regression on rule bytes-edibles-v1 host=helios-worker-1'
```

Example completion page:

```bash
page-dave -p 5 -t 'parsekit learning completed: pending-purchases/curaleaf' \
  'resolved=7 commits=3 unresolved=2 head=abc123 batch=2026-05-17T13:42Z'
```

### Noise control

Add dedupe/throttle by `(tenantId, headSha, errorHash)` with a cooldown window, e.g. 30 minutes.

Do **not** page on every rejected LLM proposal. Page only when:
- a live snapshot is threatened, or
- a learning run finished and humans explicitly want a summary.

---

## 11. Configs repo + deploy model

### Repo

`github.com/FreshlyBakedNYC/parsekit-configs`

### Proposed layout

```text
parsekit-configs/
  repo.jsonc
  use-cases/
    pending-purchases/
      defaults.jsonc
      tenants/
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
      defaults.jsonc
      tenants/
    ecom/
      defaults.jsonc
      tenants/
```

The repo stays **data-only**. Dialect packs and transform implementations live in the parsekit library code, referenced by `dialect` IDs such as `metrc-v1`.

### Deploy model

- **Library code** deploys with normal application deploys via `self-deploy`.
- **Config repo** deploys independently via `self-deploy-configs`.
- The worker is given a **watch location** pointing at the deployed clone.

### Compatibility contract

`repo.jsonc` should carry a schema version and optionally a minimum library version. The loader should reject incompatible config versions and page P5.

### Source of truth

The config repo should be the source of truth for generalized parser behavior. DB remains the source of truth for:
- brand profiles
- aliases
- observations
- rule/application telemetry

If DB rule records are retained, they should reference config rule IDs and commit SHAs rather than become a second behavior store.

### Live-learning commit model

For v1, validated data-only config changes can be **committed and pushed directly** from the worker to the config repo branch used for deploy. That keeps `git pull --ff-only` workable on other nodes and makes partial learning actually durable.

---

## 12. METRC migration plan (first consumer)

### Scope

Replace the current parser dispatch in:

- `src/worker/jobs/generatePendingPurchasePacketJob.ts`
  - `parseProductName` around line 1795
- integrate with existing DB support in:
  - `src/server/db/queries/pendingPurchaseParserQueries.ts`

### Recommended migration

#### Phase 1 — core package + METRC dialect `(L)`

Build `src/lib/parsekit/` and `src/lib/parsekit/node/` with:

- JSONC loader
- arcsecond compiler
- `metrc-v1` dialect pack
- validator + goldens
- watch-loader
- pager integration

#### Phase 2 — port the 12 hardcoded parsers `(L)`

Port each current parser family into tenant configs:

- Curaleaf
- Bytes
- Outrankd
- The Gram
- Moonlit
- Smartbud
- HerbCode
- Jennys
- PoshPuff
- LayUp
- Cannabals
- HrBotanical

This is feasible because most are straightforward pattern families; the only slightly branchy ones are Curaleaf, Cannabals, and HR Botanical.

#### Phase 3 — seed goldens from current behavior `(M)`

Create a migration script that:

1. replays known raw names through the existing TS parsers
2. captures their normalized outputs
3. writes initial goldens into each tenant config

That gives fast parity and prevents accidental regressions.

#### Phase 4 — integrate worker parsing `(M)`

Replace the hardcoded parser call path with:

- DB exact override, if still retained
- parsekit METRC parse
- LLM gap-fill
- unresolved observation

To minimize diff, keep a wrapper named `parseProductName`, but have it call the parsekit runtime.

#### Phase 5 — DB adjustments `(S/M)`

Change rule-kind typing to introduce `parser_combinator` and retire active use of `regex`.

Recommended active model after cutover:

- `exact_name`: optional bridge/emergency override
- `parser_combinator`: config-backed generalized parser reference

Keep:
- brand profiles
- aliases
- observations

#### Phase 6 — offline replay gate, then hard cutover `(M)`

Replay recent historical pending-purchase rows. Fix parity gaps. Then deploy with no feature flag.

### Important compatibility note

The current worker type includes `searchTerm`; keep that in `metrc-v1` output to avoid downstream churn even if product docs often omit it.

---

## 13. Forward-compat constraints for LitAlerts (use-case 2) and ecom pages (use-case 3)

To avoid painting v1 into a METRC-only corner, hold these constraints from day one:

1. **Core parser API must be generic over output type.**
   `ParsedProductName` is just the first dialect schema, not a global shape.

2. **Transforms must be pure, named, and data-driven.**
   That is what makes them reusable for `FuzzyVariantDescriptor`.

3. **Do not bake METRC field names into the engine.**
   The engine knows captures, projections, transforms, and schemas.

4. **Keep source adapters outside the core.**
   For ecom, adapters turn HTML/JSON-LD/sitemap data into candidate strings; parsekit still parses strings.

5. **Allow multiple entrypoints per tenant/use-case.**
   LitAlerts may parse SKU text differently from long titles; ecom may try title first, then JSON-LD, then variant chips.

6. **Keep Node-only code out of the core.**
   Browser review tools must be able to compile configs, run goldens, and preview output entirely client-side.

This is enough flexibility for the later use-cases without making METRC v1 overly abstract.

---

## 14. Public TypeScript API surface

### `parsekit` (isomorphic)

```ts
export interface ParseRequest<TContext = unknown> {
  useCase: string
  tenantId: string
  input: string
  context?: TContext
}

export interface ParseSuccess<TOutput> {
  ok: true
  output: TOutput
  ruleId: string
  tenantId: string
}

export interface ParseFailure {
  ok: false
  reason: 'no_match' | 'validation_error' | 'tenant_unavailable'
  diagnostics?: string[]
}

export type ParseResult<TOutput> = ParseSuccess<TOutput> | ParseFailure

export function compileTenant<TOutput, TContext>(
  dialect: DialectPack<TOutput, TContext>,
  config: TenantConfig
): CompiledTenant<TOutput, TContext>

export function createEngine(registry: DialectRegistry, tenants: TenantConfig[]): ParseEngine

export function validateTenant(config: TenantConfig, dialect: DialectPack<any, any>): ValidationReport

export function runGoldens(compiled: CompiledTenant<any, any>): GoldenReport

export function applyCanonicalEdits(
  configObjects: TenantConfig[],
  edits: CanonicalEdit[]
): CanonicalEditResult
```

### `parsekit/node`

```ts
export function createWatchLoader(options: WatchLoaderOptions): Promise<WatchLoader>

export function loadRepoFromPath(rootPath: string): Promise<LoadedRepo>

export function applyCanonicalEditsAtPath(
  rootPath: string,
  edits: CanonicalEdit[]
): Promise<CanonicalWriteResult>

export function commitAndPushRepo(rootPath: string, message: string): Promise<GitCommitResult>

export function createPageDavePager(): Pager
```

### METRC convenience wrapper

Add a thin Helios-facing wrapper:

```ts
export function parsePendingPurchaseProductName(input: {
  rawName: string
  tenantHint?: string
  distributorNames?: string[]
}): ParseResult<ParsedProductName>
```

That keeps the rest of the worker code simple.

---

## 15. Failure modes & operational characteristics

### Failure modes

1. **Bad JSONC / invalid schema**
   Loader rejects the changed tenant, keeps the last good snapshot, pages P5.

2. **Golden regression**
   Same behavior: reject swap, keep prior snapshot, page P5.

3. **Missed filesystem events**
   `git pull` polling recovers.

4. **Diverged or failed git pull**
   Keep current snapshot; page only after repeated failures or if deploy freshness matters.

5. **LLM proposes an overbroad rule**
   Goldens and affected-tenant regression should block the commit.

6. **LLM cannot safely generalize**
   Prefer a narrow literal rule or leave unresolved.

7. **One tenant config is broken**
   Only that tenant becomes unhealthy; others keep working.

8. **Cold start with no valid snapshot for a tenant**
   Return `tenant_unavailable`, store an observation, and page.

### Operational characteristics

- Normal parse path is **synchronous and local**.
- No network is required unless the caller invokes the learning loop.
- Reloads are **async and staged**.
- State is **immutable snapshot based**, which makes hot reload safe.
- Per-tenant isolation prevents one bad vendor config from becoming a site-wide outage.
- Performance should be fine at current scale. The initial METRC set is small enough that a simple ordered rule list is good enough.

### When to revisit with a more advanced path

Only revisit if one of these becomes true:

- >100–200 rules per tenant and parse latency becomes noticeable
- heavy ambiguity causes backtracking pain
- reviewer ergonomics with JSONC AST become a real bottleneck
- live-learning needs PR/approval workflows instead of direct pushes

Until then, the simple model is the right one.

---

## 16. Open questions

1. **Direct push vs PR flow for live-learning**
   V1 can safely push validated data-only config commits directly, but do we eventually want a PR review gate for generalized changes?

2. **DB exact-name bridge duration**
   Should `exact_name` remain an active execution path long-term, or should all active parse behavior move fully into the config repo?

3. **Tenant creation policy**
   Can the learner create entirely new tenant files automatically, or should new tenants remain manual-only in v1?

4. **Comment preservation expectations**
   Is canonical rewrite without fine-grained comment preservation acceptable for reviewers?

5. **Replay gate size before cutover**
   How much historical pending-purchase data should be replayed before hard cutover: 30 days, 90 days, or a curated corpus plus live recent rows?

6. **Completion paging default**
   Should successful learning-batch completion pages be on by default, or only for manually triggered runs?

7. **Rule telemetry storage**
   Do we want DB records keyed by `(configRuleId, configCommitSha)` for match/failure statistics, or is observation-only storage enough at first?

---

This design keeps v1 intentionally simple: **JSONC configs, arcsecond execution, per-tenant immutable snapshots, goldens everywhere, and a narrow structured learning loop**. That is enough to replace the current METRC parser cleanly without overbuilding.
