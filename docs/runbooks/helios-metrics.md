# Helios `/metrics` operator runbook

> Owning epic: [FreshlyBakedNYC/automation#21](https://github.com/FreshlyBakedNYC/automation/issues/21)
> Parent: [virusdave/top-level#7](https://github.com/virusdave/top-level/issues/7)
>
> Live URL: <https://helios.freshlybaked.us/metrics> (operator-only,
> behind the oauth reverse proxy).

This runbook covers everything an operator needs to **maintain and
extend** the `/metrics` page tree in Helios. It deliberately does
**not** restate the design — that lives in
[`docs/epics/business-metrics/EPIC_PLAN.md`](https://github.com/virusdave/top-level/blob/master/docs/epics/business-metrics/EPIC_PLAN.md)
in the top-level repo. Read that first if you need to know **why**;
this file is the **how**.

## TL;DR

- `/metrics` is a left-nav of metric panels grouped by `metric.group`.
- Every panel is a `MetricDef` object exported from a TypeScript file
  under [`helios/src/server/src/metrics/`](../../helios/src/server/metrics).
- The chart wrapper handles pan / zoom / annotate / shared-axis-lock
  for you. You only ever write the metric's `query` function and its
  metadata (id, title, series, default aggregation).
- Adding a new metric is **two lines** of registry change (one import,
  one entry in the array) plus the new MetricDef file.
- Annotations are stored in `metric_annotations` (migration `030`).
  They render as 4px ticks at the bottom of every chart whose visible
  window covers their `t_start`; soft-deletes are recoverable from
  the DB.

## "I want to add a new metric X"

### 1. Pick a file path

Metrics live under `helios/src/server/metrics/<group>/<id>.ts`. Pick
a folder name that matches the operator-facing **group** the metric
will appear under in the left-nav (this is **not** load-bearing —
the registry sorts the left-nav by `metric.group`, not by file path —
but consistent folder naming makes the tree easy to grep).

For example:

- `helios/src/server/metrics/acquisition/first_vs_returning.ts`
- `helios/src/server/metrics/margins/effective_gm_pct.ts`
- `helios/src/server/metrics/_demo/flat_line.ts`

The `_demo/` and `_stub/` prefixes are conventional for
non-production metrics; the leading underscore puts them at the
top of an alphabetical `ls` so a reviewer immediately sees they
are not real production data.

### 2. Author the `MetricDef`

```ts
// helios/src/server/metrics/acquisition/first_vs_returning.ts
import type { MetricDef } from '../types.js'

export const metric: MetricDef = {
  id: 'acquisition.first_vs_returning',
  group: 'Customer acquisition',
  title: 'New vs returning customer purchases',
  description: 'Stacked count of completed orders per bucket …',
  series: [
    { id: 'first_time', label: 'First-time', colour: '#2ca02c' },
    { id: 'returning',  label: 'Returning',  colour: '#1f77b4' },
  ],
  defaultAggregation: 'week',
  supportedAggregations: ['total', 'month', 'week', 'date', 'hour'],
  query: async ({ sites, from, to, agg }) => {
    // returns Array<{ t: ISO8601, first_time: number, returning: number }>
    // …SQL goes here…
  },
}
```

#### Field reference

- **`id`** — globally unique, dotted-name convention
  (`<group_token>.<name>`). Used in URLs (`GET /api/metrics/<id>`)
  and as the `scope` of metric-specific annotations
  (`scope = 'metric:<id>'`). NEVER rename a live metric id without
  reading the "Renaming a metric" section below.

- **`group`** — the operator-facing string the metric appears under in
  the left-nav. Match the spelling of an existing group exactly to
  splice into it; pick a new string to create a new group.

- **`title`** — short title shown in the chart header. Lower-case is
  conventional for metadata-shaped titles ("avg basket $ by …"),
  upper-case for noun-phrase titles ("Customer origin map").

- **`description`** — optional one-paragraph caveat / definition shown
  under the title. Use this for non-obvious denominators ("excludes
  unknown-cost line items from both numerator and denominator").

- **`series`** — one entry per line / band / dot you want the chart to
  render. The `id` is the row key the `query` function emits; the
  `label` is shown in the legend; the optional `colour` is a CSS
  colour string (falls back to a deterministic palette pick).

- **`defaultAggregation`** — the time-bucket size the chart uses when
  the page-level aggregation control is left at the default. Must
  appear in `supportedAggregations`.

- **`supportedAggregations`** — subset of
  `'total'|'month'|'week'|'date'|'hour'|'dow'|'dom'|'dofortnight'`.
  Any aggregation not listed here is rejected by `GET /api/metrics/<id>`
  with HTTP 400, so the chart never tries to render a value it can't
  produce.

#### Picking `defaultAggregation`

| Cadence the operator cares about           | Default       |
| ------------------------------------------- | ------------- |
| Cross-week trend (most business metrics)    | `week`        |
| Day-level detail (incidents, A/B, sales)    | `date`        |
| Intra-day pattern (cashier throughput)      | `hour`        |
| Snapshot at "now" (inventory, lowstock)     | `date`        |
| Year-over-year comparison                   | `month`       |

The operator can always switch via the page-level or per-chart
override; this is just the first thing they see.

### 3. SQL idioms — when to use what

Helios's primary store is postgres (Tiger Cloud) with `pg_timescale`
available on a subset of tables. The aggregation engine for a metric
query is whichever of these matches your data shape best:

1. **`time_bucket()` on a timescale hypertable** — the cleanest path
   for anything that already lives in a hypertable. Example:

   ```sql
   select time_bucket($1, completed_at) as t,
          sum(case when is_first_time then 1 else 0 end) as first_time,
          sum(case when not is_first_time then 1 else 0 end) as returning
     from orders_view
    where completed_at >= $2 and completed_at < $3
      and ( cardinality($4::text[]) = 0 or site_id = any($4) )
    group by 1
    order by 1
   ```

   Pass `agg` through a tiny enum-to-interval lookup
   (`'hour' → '1 hour'::interval`, `'date' → '1 day'::interval`,
   `'week' → '1 week'::interval`, `'month' → '1 month'::interval`).
   The `dow` / `dom` / `dofortnight` aggregations are categorical and
   need a different shape — see below.

2. **Plain postgres `date_trunc()` for non-hypertable sources**, e.g.
   `pricing_snapshot`, `pending_purchase_packets`. Works fine for
   metric windows up to a year; beyond that, materialise into a
   hypertable.

3. **DuckDB fall-back** — if the metric requires window functions
   over a JSON-encoded array column, or a heavy join across
   non-timescale tables, query postgres for the raw rows and let
   DuckDB do the aggregation in-process. Pattern lives in
   [`helios/src/server/pricing/*`](../../helios/src/server/pricing/).
   Use sparingly: postgres is faster for anything time-series shaped
   that fits in memory at the page-level aggregation.

4. **Sweed RPC fall-back** — if the data does not yet live in helios
   (orders, completed sales, line-item costs, shift logins) and the
   metric only needs the last N days, you may call
   `store.sale.invoice.list` / `user.compliance.list` etc.
   **inline** in the metric query. **Wrap it in `withSweedSession`**
   so you don't burn an auth pool token across requests:

   ```ts
   import { withSweedSession } from '../worker/sweed/session.js'

   query: async ({ sites, from, to, agg }) => {
     return withSweedSession(async (sess) => {
       const invoices = await listSweedInvoices(sess, { from, to, sites })
       return aggregateInvoicesByBucket(invoices, agg)
     })
   },
   ```

   Inline RPC fall-back is **explicitly a stopgap** — the right
   long-term home is a periodic ingest that materialises into
   helios postgres. Once that ingest exists, rewrite the metric's
   `query` to read postgres and drop the `withSweedSession` call.

#### Categorical aggregations (`dow`, `dom`, `dofortnight`)

These slice the data on a categorical axis (day-of-week,
day-of-month, day-of-fortnight) rather than a time axis. Emit one
row per category, using the **bucket-start of the category's first
occurrence in the window** as the row's `t` so the chart sorts
sensibly. The chart will render them as a bar / dot rather than a
line if the `agg` query param is `dow`/`dom`/`dofortnight` (the
client renderer picks based on agg, not on a flag in the MetricDef).

### 4. Keep the `sites` filter SQL-injection-safe

The query receives `sites: readonly string[]` exactly as the operator
typed it into the global controls bar. **Never** splice these
strings into SQL. Bind them as parameters and let postgres do the
filtering:

```ts
const result = await pool.query(
  `select … where ( cardinality($1::text[]) = 0 or site_id = any($1) )`,
  [sites],
)
```

Empty array → no site filter (i.e. all sites). If your metric needs
to translate site identifiers from operator-facing names
(`'midtown'`, `'bushwick'`) to internal ids, do that **before**
passing to SQL — for now the demo metrics ignore `sites` entirely,
which is the safest default.

### 5. Register the metric

Open
[`helios/src/server/metrics/registry.ts`](../../helios/src/server/metrics/registry.ts)
and add the import + array entry:

```ts
import { metric as acquisitionFirstVsReturning } from './acquisition/first_vs_returning.js'

const METRICS: readonly MetricDef[] = [
  // …existing entries…
  acquisitionFirstVsReturning,
]
```

The registry runs a load-time sanity check (every metric has a
unique id, declares ≥1 series, has a `defaultAggregation` that's in
its `supportedAggregations`) — a misconfigured metric will crash
the server boot rather than ship silently broken to operators.

### 6. Test before pushing

```sh
cd helios
npx tsc -p tsconfig.server.json --noEmit   # typecheck
npx vitest run src/server/metrics          # registry + helper tests
./scripts/smoke-server.ts                  # SPA boot + asset serve
```

The pre-commit hook (`.githooks/pre-commit`) re-runs the server
typecheck and the smoke test on every commit that touches `helios/`.
You should NEVER use `--no-verify` to bypass it.

## Annotations

The `metric_annotations` table backs every annotation across the
`/metrics` page tree.

### Schema (migration `030_metric_annotations.sql`)

```sql
create table metric_annotations (
  id          uuid primary key default gen_random_uuid(),
  author      text not null,        -- operator email
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  t_start     timestamptz not null,
  t_end       timestamptz,          -- null = point annotation
  title       text not null,
  body        text not null default '',
  tag         text,                 -- free-form; drives indicator colour
  scope       text not null,        -- 'global' | 'metric:<id>'
  deleted_at  timestamptz           -- soft delete
);
```

### Concepts

- **Point vs range** — `t_end is null` means a point annotation
  (single tick at `t_start`); `t_end is not null` means a range
  annotation (also drops a low-opacity translucent band across
  `[t_start, t_end]`). The DB enforces `t_end >= t_start`.

- **Scope** — `'global'` annotations appear on every chart whose
  visible window covers `t_start`; `'metric:<id>'` annotations only
  appear on the chart for that specific metric id. The id is the
  same string as `MetricDef.id`. Annotations whose `scope` references
  an unknown metric id (renamed / removed) are simply not surfaced
  by the UI — the row stays in the DB so an operator can re-target
  it manually.

- **Tag** — free-form string used for the indicator's colour. The
  client maps the conventional tags (`incident`, `change`, `launch`,
  `experiment`, `sale`, `note`) to specific colours and falls back
  to a default grey for anything else. **You do not need to register
  a new tag** — just type it in the create form. The hover-tooltip
  always shows the literal tag string.

- **Soft delete** — `delete /api/metric-annotations/<id>` sets
  `deleted_at = now()`. The v1 list endpoint hides soft-deleted rows
  unless `?includeDeleted=true`. Recover an accidental delete with:

  ```sql
  update metric_annotations set deleted_at = null, updated_at = now()
   where id = '<uuid>';
  ```

### CRUD endpoints

- `GET /api/metric-annotations?from=&to=&scope=&includeDeleted=`
  — list. Bounds + scope are optional; an unbounded read returns
  every non-deleted row.
- `POST /api/metric-annotations` — create. Body matches
  `MetricAnnotationsCreateBodySchema` in
  [`shared/contracts/api/metrics.ts`](../../helios/src/shared/contracts/api/metrics.ts).
- `PATCH /api/metric-annotations/<uuid>` — partial update; only
  fields present in the body are changed.
- `DELETE /api/metric-annotations/<uuid>` — soft delete; returns
  204. Idempotent — deleting an already-deleted row is a 204 too.

Reads require role `viewer`; writes require `editor`.

## Sanity checks after a Sweed backfill

When the worker re-pulls historical orders from Sweed (whether via a
new ingest pipeline or a manual `store.sale.invoice.list` backfill),
the metric values for the backfilled window can shift. To audit
that the backfill landed cleanly:

1. **Cross-check totals against the existing `/pricing` daily
   summary.** The daily totals shown on `/pricing` are derived
   from the same `store.sale.invoice.list` rows the `margins.*` and
   `acquisition.*` metrics aggregate. Sum the `margins.gross_margin_dollars`
   series across the backfilled window and confirm it matches the
   `/pricing` total for the same range to within rounding.

2. **Annotate the backfill window.** Drop a `tag=change`, `scope=global`
   annotation spanning the backfilled `[t_start, t_end]` with title
   "Sweed backfill: <reason>" so any future surprise in the metric
   history is immediately attributable.

3. **Look for `null`-cost spikes.** If `margins.effective_gm_pct`
   moves by more than a few points on a day inside the backfill
   window, it usually means the backfill landed line-items without
   wholesale cost, and the denominator is shrinking. Investigate
   the worker logs for that ingest run.

## Renaming / removing a metric

**Don't rename a live metric id.** The id is used as:

- The URL path for `GET /api/metrics/<id>`.
- The scope of metric-specific annotations (`scope = 'metric:<id>'`).
- The "satisfies" link in operator-shared screenshot URLs
  (`/metrics?metric=<id>`).

If you absolutely must rename:

1. Add the new id alongside the old one in the registry. Both serve
   the same data; the old id stays around for at least one
   operator-week.
2. Run a `metric_annotations` `update` to migrate `scope =
   'metric:<old>'` rows to `'metric:<new>'`.
3. Post a `tag=change`, `scope=global` annotation explaining the
   rename.
4. Wait a week; remove the old id.

Removing a metric is the same minus step 1 — soft-delete its
annotations (or migrate them to `scope = 'global'`) before pulling
the registry entry.

## P2-P6 status: stubs vs real data

The P0/P1 framework + the P2-P6 metric **IDs / titles / series /
groups** all ship in v1. The data-side of P2-P6 — i.e. the actual
SQL that returns real numbers instead of synthetic random walks —
needs a Sweed orders ingest pipeline that does **not yet exist**
in helios. Pulling completed orders + line items + wholesale costs +
fulfillment / payment fields from `store.sale.invoice.list` is a
multi-week piece of work and is tracked as a sibling epic.

While that lands, every spec'd metric ships as a **stub**:

- The metric appears in the left-nav under its real group.
- The chart frame, controls, and annotation surface all work.
- The `query` function returns deterministic synthetic data so the
  chart renders.
- The description starts with `STUB: synthetic data — real-data SQL
  pending` so an operator can't confuse it with a real metric.

When the ingest lands, each stub is rewritten in place — same
file, same id, same title, same series — and the `STUB:` prefix
is dropped from the description. The page-tree IA, the left-nav,
the operator's bookmarks, and the historical annotations all
survive untouched.

## v2 follow-ons (deferred from this epic)

Per the parent EPIC plan, the following are explicitly **out of v1
scope** and ship as separate issues once the v1 framework is
operational:

- `cashier.upsell_lift` — per-cashier statistically-significant
  basket-size lift vs the same-shift population baseline. Requires
  a stable customer-id join and a significance-test runner (likely
  Welch's t with bootstrap CIs).
- `promos.summary` + `promos.detail` — promo performance dashboards.
- `customers.origin_playback` — animated time scrub for the
  customer-origin map.
- Threshold-based alerting on any metric.
- Mobile-optimised layout (Helios is desktop-first; tablet/phone are
  best-effort via the existing layout breakpoints in
  `client/styles/index.css`).

Each of these gets its own GitHub issue at this child epic's close.

## Closure comment (post on `virusdave/top-level#7` at P7 land time)

Use this template:

```markdown
Closing out the child epic in [FreshlyBakedNYC/automation#21](https://github.com/FreshlyBakedNYC/automation/issues/21).

- Live URL: <https://helios.freshlybaked.us/metrics>
- Per-phase commit links:
  - P0 (schema + API contract): <commit-sha>
  - P1 (chart wrapper + page shell): <commit-sha>
  - P2 (acquisition + margins): <commit-sha>
  - P3 (basket / category / fulfillment): <commit-sha>
  - P4 (inventory / slow movers / running low): <commit-sha>
  - P5 (cashier / weather / delivery): <commit-sha>
  - P6 (customer origin map): <commit-sha>
  - P7 (runbook): <this commit>
- Deferred v2 items + follow-on issues:
  - `cashier.upsell_lift` → automation#NNN
  - `promos.summary` + `promos.detail` → automation#NNN
  - `customers.origin_playback` → automation#NNN
  - Threshold alerting → automation#NNN
  - Mobile-optimised layout → automation#NNN
- Acceptance criteria #1–#6 from the parent EPIC: verified on
  vps-nixos-3.

Satisfies: virusdave/top-level#7
```
