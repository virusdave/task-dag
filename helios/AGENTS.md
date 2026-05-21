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
