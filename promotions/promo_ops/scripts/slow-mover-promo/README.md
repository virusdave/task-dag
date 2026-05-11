# slow-mover-promo

Generates a static HTML reviewer packet that proposes **category** or
**category × brand** groups at a Sweed site whose live inventory is not
moving fast enough relative to its retail value. Designed so the entire
module can be lifted into Helios with only an env-config rewrite.

## Run

```bash
# from promo_ops/
SWEED_AUTH_TOKEN=... BEDROCK_MANTLE_BEARER_TOKEN=... \
  npx tsx scripts/slow-mover-promo/index.ts \
    --site=midtown --days=14 \
    --out=out/slow-mover-promo
```

Convenience npm script: `npm run slow-mover:midtown`.

Both secrets are auto-discovered from `/Users/amp-local/.secret/sweed/auth-token`
and `/Users/amp-local/.secret/bedrock/mantle-bearer-token` if the env vars
are not set.

Flags:

- `--site=midtown` – the only site wired in today (dealer 210705).
- `--days=14` – trailing sales window, capped at 90.
- `--out=...` – output directory; defaults to `out/slow-mover-promo`.
- `--no-llm` – skip the Mantle pass and use deterministic ordering only.
- `--today=YYYY-MM-DD` – override "today" for reproducible test runs.

## Outputs

```
out/slow-mover-promo/
  index.html               # ranked candidate groups + executive summary
  groups/<slug>.html       # per-group detail with the per-SKU price ladder
  data.json                # full raw aggregate + LLM payload (for diffing
                           # and for the future Helios route to consume)
```

Each row in `index.html` opens its detail page in a new tab.

## Data sources

| Surface | RPC | Used for |
|---|---|---|
| `store.auth.dealer.set` | switches the session into the site dealer |
| `store.bi.auth.jwt` | fetches the BI JWT once per session |
| `store.inventory.item.list.grouped` | live on-hand inventory: per-product brand/category, per-lot wholesale cost, oldest receive date, current retail price |
| Cube `/cube/v1/load` `PromotionEffectiveness` | trailing-N-day net sales / units / gross margin / promo discount, broken down at category, category×brand, and category×brand×product levels |

Cube `PromotionEffectiveness` is the canonical sales fact-table cube here
(despite the name) — its totals match `SaleReport` and it provides the
richest dimension set, including productCategory, productBrand, and
productID.

## Scoring

Deterministic; the LLM only re-ranks and writes prose. Defaults
(`DEFAULT_SCORING` in `lib/aggregate.ts`):

- `minDaysOfSupply: 21`
- `minInventoryRetailValue: 250`
- `weakSellThroughPct: 25`
- `agedReceiveDays: 30`

Each candidate group accumulates weighted signals for days-of-supply,
sell-through, inventory $ exposure, age, low-velocity (no sales in window),
and gross-margin cushion. The opportunity score is the sum of signal
weights; reviewer thresholds and weights are intentionally tunable in one
place.

A category and its brand-within-category subgroups are de-duplicated:
when an entire category is slow we surface a `category` proposal, otherwise
we surface the `category-brand` splits. Single-SKU promos are intentionally
avoided.

## Private LLM use

Registered in [`config/llm_use/registry.yaml`](../../../../config/llm_use/registry.yaml)
under `slow-mover-promo-group-ranking-and-rationale` (limited-trial,
`google.gemma-3-27b-it`). The LLM:

- re-ranks candidate groups across multi-feature trade-offs,
- writes a single-sentence reviewer-facing rationale per group,
- writes a 2-3 sentence executive summary for the packet header.

The LLM never picks a discount level, never invents categories/brands/SKUs
not in the input, and never decides whether to ship a promo.

If Mantle is unavailable, the script falls back to the deterministic
ordering and writes a plain summary; the packet still renders cleanly.

## Helios merge plan

The module is intentionally a single self-contained directory:

- `lib/sweed.ts` – RPC + Cube client (drop-in replaceable by
  `helios/src/server/sweed/*` when merged)
- `lib/data.ts` – inventory + sales pull (no UI/HTML)
- `lib/aggregate.ts` – pure functions; no I/O; safe to unit-test
- `lib/mantle.ts` – Mantle helper; same shape as other Helios LLM helpers
- `lib/render.ts` – HTML packet renderer; output path-agnostic
- `index.ts` – CLI entrypoint; the parts a Helios route would replace

When promoted to Helios:

1. Replace `loadSweedClientConfig` and `loadMantleConfig` with
   `getServerEnv()` lookups.
2. Replace the CLI `index.ts` with a Helios route that calls
   `loadLiveInventory` + `loadSiteSales` + `aggregateSlowMovers` and
   serves either the rendered HTML packet directly or the `data.json`
   payload to a React review queue.
3. Reuse `lib/aggregate.ts` and `lib/render.ts` unchanged.
