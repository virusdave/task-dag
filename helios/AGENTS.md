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
