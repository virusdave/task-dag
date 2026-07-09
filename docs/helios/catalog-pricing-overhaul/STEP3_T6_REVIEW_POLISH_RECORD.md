# Step 3 T6 review / polish record — in-page catalog-pricing feedback

Parent umbrella: [virusdave/top-level#35](https://github.com/virusdave/top-level/issues/35).  
Automation child epic: [FreshlyBakedNYC/automation#59](https://github.com/FreshlyBakedNYC/automation/issues/59).  
Task-dag leaf: `907fe10c9e81eccc65f249945fd023d16ec6a2e4`.

This is the durable T6 closeout record for the step-3 work that turned the
Catalog Family Explorer's existing LitAlerts market-match diagnostic into an
operator action surface for price-outlier review and parse-correction feedback.

## Landed step-3 commits reviewed

| Task | Implementation tip | Completion commit | Scope |
| --- | --- | --- | --- |
| T1 | `20dfd03` | `a3e3d12` | price-outlier helper + market-match contract fields |
| T2 | `17ac54c` | `d85d0da` | compact outlier review UX in `MarketMatchPanel` |
| T3 | `f89dc62` | `9595b6c` | inert LitAlerts parse-feedback inbox + `retailerId` contract |
| T4 | `356659d` | `978b566` | parse-correction drawer / mobile bottom sheet + inline feedback save |
| T5 | `bce693e` | `2383fb6` | promotion provenance + export shape, no web-side git writes |

## Review outcome

- **Live page:** `https://helios.freshlybaked.us/catalog/family-explorer`
- **Operator action path:** expand a brand categorical family, open the
  LitAlerts market-match panel, use the `Needs review` cards or sticky score-cell
  `✎` action, then save listing correction / optional convention feedback in the
  drawer.
- **Outlier method:** Tukey IQR fences over finite positive pre-tax prices with a
  minimum basis of 5; near-degenerate IQR is widened by a conservative
  tight-cluster guard (`max($5, 20% of median)`). Outliers are a review signal
  only: they never remove, down-rank, or reorder candidates.
- **Outlier basis rules:** stats are computed over the full scored family before
  the display cap, restricted to above-threshold same-hard-gated candidates;
  below-threshold / wrong-family / missing-price candidates are excluded from the
  basis and from flagging. `reviewCandidates` is separately bounded to 25 with
  overflow surfaced.
- **Feedback → promotion boundary:** saved feedback is inert in Helios. It may
  mark rows and feed a promotion export, but it does not change production
  scoring, IQR, `fuzzy_skus`, market aggregates, or parser behavior. Promotion
  remains an agent/reviewer flow into `helios-parser-configs` parsekit goldens
  and parser configs; the web UI does not write git configs.

## Mobile / UI-review notes

- The panel summary shows a `price review` pill only when outliers exist; zero
  outliers produce no extra summary noise.
- The first action surface is a compact `Needs review` strip above the wide
  table. Cards wrap on desktop and stack naturally on mobile, so the operator
  can see listing, retailer, direction/delta, price, size context, feedback
  state, and `Fix parse` before horizontal table scrolling.
- The score column remains sticky in the wide table and carries both the outlier
  direction badge and the `✎` fix action. There is no far-right-only action
  column hidden off-screen on mobile.
- The correction UI is a drawer on desktop and bottom sheet on mobile. It keeps
  the next action visible with chip-driven field reveal instead of front-loading
  a giant form, and its copy explicitly says saved feedback is inert until
  promoted.
- Oracle's T6 review found no UI blockers and approved a docs-only T6 review
  record as reasonable when backed by the full gate evidence.

## Bounded LitAlerts / DB review

- No new partner API pull was introduced in this step; the page reads already
  materialized `fuzzy_skus` / LitAlerts mirror tables.
- The family market-match fetch is capped at `FAMILY_FETCH_LIMIT = 500` and the
  displayed scored candidates are capped at 200.
- The review list is capped at `REVIEW_CANDIDATES_LIMIT = 25` and overflow is
  reported instead of fetching more.
- The nearest-retailer distance fan-out is bounded to displayed candidates plus
  review candidates (at most 200 + 25 before de-dupe).
- Existing feedback badges fetch only a bounded, de-duplicated fuzzy-sku id set;
  the current page does not use a retailer-wide feedback read.
- Promotion export is retailer-scoped, status-filtered, and bounded by its route
  contract.

## Verification run for T6

All commands were run in the prepared ephemeral automation worktree on
`vps-nixos-3`; no prod DB writes, prod resource tests, SSH, or manual service
actions were used.

```text
cd helios && npm run test -- \
  src/shared/marketMatch/priceOutliers.test.ts \
  src/client/routes/catalog/parseCorrectionDraft.test.ts \
  src/server/db/queries/catalogParseFeedbackQueries.test.ts \
  src/server/parsekit/parseFeedbackPromotion.test.ts
→ 4 files passed, 63 tests passed

cd helios && npm run typecheck && npm run typecheck:client
→ passed

cd helios && large-action-lock -- bash -lc \
  'npm run check && NODE_OPTIONS=--max-old-space-size=8192 npm run build'
→ npm run check: 185 files passed / 5 skipped; 2168 tests passed / 26 skipped
→ npm run build: server + client build passed
```

Oracle T6 review summary: **approved / no blocking findings**. It verified the
outlier basis/display-cap behavior, mobile action accessibility, inert feedback
boundary, bounded LitAlerts fan-out, and deterministic/prod-resource-free test
coverage.
