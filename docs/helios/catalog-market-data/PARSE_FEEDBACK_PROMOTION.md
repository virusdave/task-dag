# Parse-feedback → parsekit promotion path

How an agent/reviewer turns the operator's **inert** LitAlerts
parse-correction feedback (issue #59, tasks T3–T5) into an authoritative
parsekit parser config in `helios-parser-configs`.

This is the promotion half of the step-3 feedback loop. The web/API side is
deliberately **inert**: nothing in the production scorer / market-match read
path joins `litalerts_parse_feedback`, and Helios **never** writes a parser
config from the web UI or an API endpoint (no web-side git writes). Promotion
is a human-in-the-loop, agent/reviewer flow that ends by *recording provenance*
back onto the DB row.

## The boundary (why it's shaped this way)

- **Helios DB (`litalerts_parse_feedback`)** — the live web input target. An
  operator, from a mis-parsed row in the brand-categorical-family market-match
  panel, saves a listing correction (+ optional retailer naming convention).
  This improves the *operator workflow* only (saved-feedback badges, prefill,
  "convention exists" hints). It is **not** a second, live parser.
- **parsekit / `helios-parser-configs`** — the single authoritative
  *executable* parser after promotion. Its configs live at
  `use-cases/litalerts/parsers/<tenantId>.jsonc` and are loaded by the Helios
  parser registry as a released snapshot (a git commit sha).

Unpromoted feedback must never change production scoring/matching,
`fuzzy_skus`, market aggregates, or IQR. See
[`helios/src/server/db/schema/litalertsParseFeedback.sql`](../../../helios/src/server/db/schema/litalertsParseFeedback.sql).

## Quick links

- Schema:
  [`helios/src/server/db/schema/litalertsParseFeedback.sql`](../../../helios/src/server/db/schema/litalertsParseFeedback.sql)
- Migrations:
  [`097_litalerts_parse_feedback.sql`](../../../helios/src/server/db/migrations/097_litalerts_parse_feedback.sql)
  (table, T3) +
  [`098_litalerts_parse_feedback_promotion.sql`](../../../helios/src/server/db/migrations/098_litalerts_parse_feedback_promotion.sql)
  (promotion provenance, T5)
- Queries:
  [`helios/src/server/db/queries/catalogParseFeedbackQueries.ts`](../../../helios/src/server/db/queries/catalogParseFeedbackQueries.ts)
- Promotion export mapper (pure):
  [`helios/src/server/parsekit/parseFeedbackPromotion.ts`](../../../helios/src/server/parsekit/parseFeedbackPromotion.ts)
- REST surface:
  [`helios/src/server/routes/catalogParseFeedback.ts`](../../../helios/src/server/routes/catalogParseFeedback.ts)
- parsekit tenant configs (source-of-truth literals today):
  [`helios/src/lib/parsekit/__tests__/litalerts-v1-fixtures.ts`](../../../helios/src/lib/parsekit/__tests__/litalerts-v1-fixtures.ts)
- jsonc exporter:
  [`helios/scripts/export-parsekit-configs.mts`](../../../helios/scripts/export-parsekit-configs.mts)

## Lifecycle statuses

`litalerts_parse_feedback.status` moves through:

```
draft ──▶ promotion_requested ──▶ promoted
   │              │                  │
   └──────────────┴──▶ rejected      └──▶ superseded (later config replaces it)
```

- **draft / promotion_requested / rejected** — carry **no** promotion
  provenance (`promoted_parser_id` / `promoted_rule_id` / `promoted_config_sha`
  are all null; enforced by the `litalerts_parse_feedback_promotion_meta_ok`
  CHECK).
- **promoted** — requires `promoted_parser_id` + `promoted_config_sha`
  (`promoted_rule_id` optional).
- **superseded** — provenance is *preserved* from the prior promotion (or stays
  null if it was never promoted).

Web writes only ever produce `draft`. `promoted` requires **admin** (it asserts
an external, reviewed parser-config commit); the other transitions are `editor`.

## The promotion export

`GET /api/catalog/family-explorer/parse-feedback/promotion-export?retailerId=<id>&statuses=<csv>`
(admin-gated, **read-only**). `statuses` defaults to
`draft,promotion_requested`.

It returns the retailer's listing corrections grouped by the parsekit tenant
they resolve to (`dispensaryToTenantId(dispensaryName)`), each group carrying
its `parserId` (`litalerts.<tenantId>`) and `configPath`
(`use-cases/litalerts/parsers/<tenantId>.jsonc`). Per correction you get:

- `rawCorrection` — the operator's stored corrected fields, verbatim.
- `bestEffortExpected` — those fields projected into parsekit's LitAlerts shape
  (nulls where the operator didn't supply / couldn't be normalized).
- `parsekitGolden` — a **ready-to-paste** `{ kind: 'match', id, input, expected }`
  golden, present **only** when `bestEffortExpected` forms a *full, valid*
  LitAlerts descriptor (validated against
  `litalertsContract.outputSchema` + `semanticValidate`). Otherwise `null`.
- `issues` — human-readable reasons the golden is null (missing category,
  unrecognized unit, etc.), for the reviewer to resolve.
- `conventionProposals` — the linked retailer naming-convention hints.

The export is bounded (`PROMOTION_EXPORT_MAX_CORRECTIONS`, retailer-scoped
indexed read); `truncated: true` means re-run narrower (by status).

## Step-by-step

1. **Select feedback.** Call the promotion export for the retailer (and, if
   you like, `statuses=promotion_requested` to see only what the operator
   flagged as ready). Note the `tenantId` / `parserId` / `configPath` for each
   group.
2. **Author / update the parser config.** In `helios-parser-configs` (or, until
   the read-path cutover, the source-of-truth TypeScript literal in
   [`litalerts-v1-fixtures.ts`](../../../helios/src/lib/parsekit/__tests__/litalerts-v1-fixtures.ts)),
   create/extend `use-cases/litalerts/parsers/<tenantId>.jsonc` so its rules
   parse the corrected listings. You author the rules/regex — the operator
   never does.
3. **Add the goldens.** Paste each `parsekitGolden` into the relevant rule's
   `goldens[]`. For corrections whose golden was `null`, resolve the `issues`
   first (map the category/unit, fill missing sizes) and construct a valid
   golden by hand.
4. **Validate.** Run the parsekit goldens/validation
   (`helios/src/lib/parsekit/__tests__/litalerts-v1.test.ts`,
   `npm run test -- litalerts-v1`) and the safety verifier. All goldens must
   pass.
5. **Review + push.** Get the config change reviewed and pushed to
   `helios-parser-configs`. Record the resulting **release commit sha**.
6. **Wait for the registry snapshot.** The Helios parser registry loads the new
   release; confirm the snapshot sha is live before marking anything promoted.
7. **Record provenance.** For each promoted DB row call
   `PATCH /api/catalog/family-explorer/parse-feedback/<feedbackId>/status`
   (admin) with:

   ```json
   {
     "status": "promoted",
     "promotedParserId": "litalerts.<tenantId>",
     "promotedRuleId": "<rule id>",
     "promotedConfigSha": "<40-hex release sha>"
   }
   ```

   `promotedRuleId` is optional. This does **not** touch git — it only stamps
   the DB row so future exports/audits know the feedback was realized.

If a later config replaces a promoted rule, move the old row to `superseded`
(its provenance is preserved).

## Realizes

This is the concrete, human-in-the-loop realization of the runtime-adjustable
parser-config work tracked under
[automation#19](https://github.com/FreshlyBakedNYC/automation/issues/19). Note
the current source is **LitAlerts** → promote into `use-cases/litalerts`;
reserve `competitor-ecom` for direct competitor e-commerce sources later.
