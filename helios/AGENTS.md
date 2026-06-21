# Agent instructions — helios pages, dashboards, and one-off HTML artifacts

These rules cover every reviewer-facing page produced under or for helios:
server-rendered dashboards, the SPA, and the throwaway HTML pages we
upload via `scripts/upload-to-mss`. They take precedence over personal
preference about "explaining your work" in the artifact itself.

## Optimize the page for reviewer efficiency

A human is going to open this URL on a phone or a laptop with limited
time and look for one thing: **the answer the page exists to show**.

- The **purpose** of the page (the data, the table, the chart, the
  decision-support widget — the thing the reviewer came here to act on)
  is the only content that should be visible and visually prominent by
  default. It should be at the top, large, and immediately usable
  without any scrolling past throat-clearing.
- Anything that is **at most useful once** — methodology notes, formula
  derivations, "how to use" instructions, generation timestamps, recall
  counts, data-source caveats, worked examples, skipped/edge-case
  tables, debug aids — must be **collapsed by default** (inside
  `<details>` or an equivalent toggle) so the page does not waste the
  reviewer's vertical screen real estate on text they have already
  internalized after their first visit.
- Collapsed sections still need to exist (we don't want to lose the
  provenance / caveat trail), they just must not be in the reviewer's
  way every time they reload the page.
- Default-visible chrome (title, primary controls, primary table /
  chart) should be tight: short title, no paragraph of preamble, no
  banner notes. If something feels worth saying in prose, it almost
  certainly belongs in a collapsed "About this page" or "Methodology"
  section.
- Buttons, sliders, and other interactive controls that drive the main
  view are part of the purpose and stay visible.

When you build or update a helios page, ask: "If my reviewer opens this
URL for the tenth time today, are they staring at the answer, or are
they scrolling past the explanation I wrote for them on visit one?"
The answer must be the former.

## Disabled / "DEAD" things in Sweed: skip non-fatally by default

Anything Sweed marks as **disabled** (`enabled: false`), or which we
have labeled as soft-retired (operator convention is to rename the
record to start with `DEAD - …`, `DEAD-`, `DELETED`, `RETIRED`, etc.),
is operationally **out of service**. Treat it as "do not use; ignore
this thing" for every Helios read, write, sweep, or maintenance job.

The rule:

- Filter disabled / DEAD-marked records out at the **list** step (e.g.
  after `store.screen.carousel.list`, `store.product.list`,
  `store.brand.list`, etc.) so the rest of the job never iterates them.
- If a downstream RPC still hits a disabled record (race, cache lag,
  or a record that flipped to disabled between two calls), **catch the
  failure and continue with empty / no-op semantics**. Do not let one
  retired record kill an entire batch job. Sweed's typical signature
  for this case is the misleading
  `Action does not exist or you do not have permission` (subcode
  14002) — see [`screensCarouselHelpers.ts`](src/worker/jobs/screensCarouselHelpers.ts)
  for the canonical predicate + error matcher to reuse.
- Log a `console.warn(...)` when a disabled record is encountered and
  skipped, so the auditor can still see what was dropped, but never
  raise.

The **only** time you should touch a disabled / DEAD record is when
the human explicitly asks to "re-enable", "reactivate", "undelete",
"restore", "resurrect", or similar — for example, asking to re-enable
a disabled brand, or to reuse a retired screen. In that case the
target record IS the work; obviously do not filter it out.

When in doubt, default to the skip-and-continue rule. A bounce that
processes 4-of-5 enabled screens and warns about the 1 disabled one
is correct; a bounce that crashes on the disabled screen and touches
nothing is not.

## Cancelled / voided orders: exclude from every total, count, and average

A **cancelled** Sweed order is not a transaction. Sweed's feed still reports
a non-zero header `grand_total` / `subtotal` on cancelled orders, and
cancellations are ~18% of orders, so any `sum(grand_total_dollars)` /
`count(*)` / average over `sweed_orders` that does not exclude cancelled
rows is silently and materially wrong (this shipped as a family of bugs:
inflated check-ins "Total $", customer-details "Lifetime spend / N
invoices", customers-map lifetime spend).

The rule:

- **Default to EXCLUDING cancelled** from every total, count, average,
  "Nth purchase" ordinal, first-vs-returning split, and fulfillment /
  payment / category split. Order-header status is at
  `raw_json->'invoiceStatus'->>'name'` = `'Cancelled'`; line status is the
  differently-spelled `raw_item->'invoiceItemStatus'->>'name'` =
  `'Canceled'`.
- **Never hand-write the predicate.** Import the canonical helper from
  [`src/server/db/sweedOrderStatus.ts`](src/server/db/sweedOrderStatus.ts)
  (`nonCancelledOrderSql` / `nonCancelledOrderPredicateSql` for headers,
  `nonCancelledLineSql` / `nonCancelledLinePredicateSql` for lines). It is
  the single source of truth; do not copy a `<> 'cancelled'` literal into a
  new module.
- **Including cancelled needs an explicit opt-out.** Only a metric that is
  *deliberately* about cancellations (e.g. "orders submitted regardless of
  completion") may include them, and must mark the aggregate with a comment
  `sweed-cancelled-intentional: <reason>`.
- A **static guard** (`src/server/db/sweedOrderStatus.guard.test.ts`, run by
  `npm run check`) fails the build if a header-dollar sum over `sweed_orders`
  lacks the guard or the opt-out marker.

Full rationale, the two status spellings, `ON`-clause placement, the
`raw_json`-drain durability caveat, and the returns/refunds data gap:
[`docs/sweed/order-status-semantics.md`](../docs/sweed/order-status-semantics.md).

## Promo actions: "Show promo price and details on product(s)" is ALWAYS on

Every Sweed promo action that helios creates, edits, or "fixes up"
MUST have the **Show promo price and details on product(s)** toggle
enabled. In the Sweed RPC payload this is the boolean field
`displayInEcommerceProducts` on `store.promo.action.get` /
`store.promo.action.edit` / `store.promo.action.add` —
`displayInEcommerceProducts: true`.

The whole point of a promo is to advertise the price to shoppers on
the product page. A promo that quietly applies at checkout but doesn't
show the discounted price on the menu is the worst of both worlds:
we eat the margin and get none of the conversion lift.

Rules:

- Any script or job that **creates** a promo action (`store.promo.action.add`)
  MUST include `displayInEcommerceProducts: true` in the request.
- Any script or job that **edits** a promo action MUST leave the field
  set to `true` (don't drop it from a full-shape edit payload that
  would default it back to `false`).
- **Never** send `displayInEcommerceProducts: false` unless the human
  has explicitly asked you to hide a specific promo from the product
  page. This is a single-promo, one-off request and should be loudly
  called out in the commit message / page-dave message.
- If you encounter existing promos with the field off (e.g. via a
  bulk audit / dashboard), the correct remediation is to flip them
  on, not to leave them as-is.

## Building the client: raise Node's heap or it OOMs

`npm run build:client` (i.e. `vite build`) transforms ~850 modules and
emits a multi-megabyte bundle. On the agent hosts the default V8 old-space
limit (~1 GB here) is **not** enough — a bare `vite build` dies partway
through `rendering chunks…` with:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

This is an environment/heap ceiling, **not** a code error, and retrying
the identical command will keep failing. Always build the client with an
enlarged heap:

```sh
NODE_OPTIONS=--max-old-space-size=8192 npm run build:client
# or, invoking vite directly:
NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/vite build
```

8192 (8 GiB) is comfortable headroom; 4096 also works today but leaves
little slack as the bundle grows. The same flag applies to `npm run build`
(which runs `build:client`) and to the `scripts/smoke-server.ts` gate when
it has to build the client first. The pre-commit hook itself only relies
on an **already-built** `dist/client`, so if you've just built with the
flag above the hook's smoke step will pass without re-building.
