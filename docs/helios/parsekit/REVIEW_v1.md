# parsekit Design Review — Adversarial Pass

*Source: private reviewer pass, 2026-05-17, against DESIGN_v1.md.*

**Verdict: Ship with changes.** Core direction (JSONC AST + arcsecond + immutable snapshots) is sound; control-plane parts (identity, learning, hot reload, source-of-truth split) need redesign before implementation.

## Critical (must fix)

1. **Composition model is backwards.** `dialect` owns `outputSchema` AND is referenced by tenant `useCase`, conflating syntax library with use-case contract. Split into three explicit concerns:
   - `ParserScope = { tenantId, useCase }` is the runtime identity.
   - `DialectPack` is a syntax library (tokens/macros/transforms) imported by ref + version.
   - `UseCaseContract<T>` owns `outputSchema` + `semanticValidate`.
2. **Multi-writer git from parallel workers is a broken control plane.** Workers MUST NOT push directly. Add DB-backed `learning_candidates` queue + a single-writer **reconciler** that leases, rebases on latest HEAD, revalidates, commits, pushes. Auto-merge only narrow edits (addGolden, exact literal rule); broad edits (priority, detect, macros, dialect) require PR/human approval.
3. **Hot reload is not actually atomic.** fs.watch + per-file debounce can see half-written trees, missed cross-file dependencies, partial deploys. Reload by **release manifest / commit SHA** — deploy writes a full tree to a staged dir, writes a manifest last, loader compiles the dependency closure, atomically swaps a generation pointer with in-flight refcount.
4. **DB-vs-config source-of-truth split is split-brain as written.** Define a hard 4-phase migration with explicit precedence: Import → Dual-read with frozen DB generalized rules → Freeze DB writes → Remove bridge. `regex`/`template` DB rule kinds without a parsekit representation are migrated by hand or kept frozen — no auto-migration.
5. **`CanonicalEdit` is too narrow for the learning loop.** Add `patchExpr`, `patchProjection`, `patchTransform`, `upsertMacro`, `upsertToken`, `setDetect`, and a policy-gated `replaceSubtree` escape hatch. Restrict which ops can auto-merge.
6. **Security model is incomplete.** Add a static safety verifier: acyclic ref/macro graph, bounded `repeat` (max required), bounded `sepBy`, max AST depth + choice fanout, input length cap, parse step/time budget, transform allowlist with arg schemas, projection allowlist, prompt-hardening (raw input only as JSON data, never interpolated), no shipping raw configs to browsers without redaction. No regex primitive without RE2/safe-regex.
7. **Hard cutover with no fallback is reckless.** Run **shadow/parity mode** alongside the existing `parseProductName`, log diffs, gate cutover on parity threshold + replay corpus. Keep a kill-switch env var to fall back to legacy for one release window after cutover.

## Important (should fix)

- **Browser story is fake scope.** Pick: (a) descope browser v1 → server preview endpoint, or (b) browser is read-only review UI loading a signed compiled snapshot, no git/JSONC/watch/LLM. **Default: (b) read-only review UI; descope authoring to v2.**
- **Golden harness needs impact scoping.** Two-tier: on auto-merge, run changed rule's goldens + overlapping-priority siblings + smoke corpus slice + collision scan. CI/nightly runs full corpus + diff vs last good snapshot.
- **Comment preservation vs canonical rewrite tension.** Decide: comments are non-authoritative and may be reflowed; first-class `notes: string[]` field on Rule for durable annotations.
- **Transform registry needs versioning + arg schemas.** `TransformCall = { name, version, args }`; per-transform Zod arg schema; determinism tests; changelog.
- **Rule selection precedence must be explicit.** Resolve parser by explicit scope first, never raw-text scan. Within parser: `priority desc, id asc`, first success wins, overlapping detect prefixes rejected at validate time.
- **Per-tenant recompile ignores shared dependency invalidation.** Maintain a dep graph (tenant → dialect → macros/tokens/transforms); reload the closure.

## Nits

- P5 paging too eager: page only when a production parser becomes unavailable or a release is stuck for sustained interval, not on every per-tenant validation failure that leaves a prior snapshot serving.
- `repeat` `max` must be required (no unbounded).
- `macro` vs `ref` semantics: `ref` = named subtree by ID; `macro` = parameterized expansion. Document.
- `ParseFailure` must include snapshot SHA, parserId, attempted rule IDs, first failure offset.
- Goldens required on tenant rules, optional on shared macros (which get unit tests instead).
- Detect normalization must be defined + documented.
- Debounce interval behind config.

## Missing topics the design must cover

Config repo layout details; release/rollback model; schema/dialect versioning + AST migrations; negative + collision testing; corpus replay policy; provenance (human vs LLM vs imported); proposal lifecycle (queued/leased/applied/superseded/rejected/merged); tenant lifecycle; access control + branch protection; browser product requirements; performance budgets; in-flight reload behavior; explicit security review items.

## Implementation order (revised DAG)

The original plan introduced the learner and hard cutover too early. Correct order:

1. Identity + schema/versioning model + repo layout + release manifest
2. Deterministic core compiler + static safety validator
3. Release loader + atomic generation swap + dep graph
4. Test harness (goldens + negatives + corpus replay + differential compare vs current `parseProductName`)
5. Port 12 METRC parsers and run **shadow mode** with parity metrics
6. Guarded cutover with kill switch
7. Read-only review UI (snapshots + parse traces)
8. Learner LAST: queue + lease + single-writer reconciler + narrow auto-merge + PR for broad edits

The three highest-impact corrections: **(1) clean parser identity, (2) single-writer reconcile, (3) release-manifest atomic reload**.
