# Gads Experiments Visualizer — UI Spec

Issue: [#11](https://github.com/FreshlyBakedNYC/automation/issues/11)
Status: agreed (mobile-first single-page HTML)

## Goal

A single self-contained HTML page that lets a human reviewer (primary device:
phone, secondary: desktop) see:

1. The summary of what gads experiments are planned, in-flight, or completed.
2. Lessons learned from prior experiments — especially "unexpected positive
   approvals that have persisted for days" (the most valuable signal).
3. A downloadable ZIP of sequentially-numbered CSV files for Ads Editor
   import.

The page is served via the `mss-one-offs` oauth-proxied service (existing
infra, no new proxy work needed) with a 24-hour TTL.

## Information architecture (top to bottom)

1. **Title bar** — page name, generation timestamp, "Download CSV bundle" button
   (sticky on mobile, prominent on desktop).
2. **Summary cards** — 1 column on phone, 4 columns on desktop:
   - Active experiments
   - Variants under test
   - Persistent positive approvals (the headline metric)
   - Total trial budget / day
3. **Persistent positive approvals** — surfaced first because it's the most
   actionable signal. Each entry: ad-group name, policy class probed, days
   surviving, hypothesis that produced it.
4. **In-flight experiments** — cards grouped by family. Each card: name,
   hypothesis, policy class, control vs variant counts, time-in-flight,
   serving status, current CTR if known.
5. **Completed experiments** — collapsed by default; tap to expand. Outcome,
   lessons learned, whether the variant survived.
6. **Planned experiments** — what the next CSV import will create.
7. **Footer** — second "Download CSV bundle" button (per issue requirement)
   plus a small generation-metadata block.

## Mobile-first rules

- Single-column layout below 768 px viewport.
- Minimum 44 px tap targets for buttons.
- Sticky download button at top so it's always reachable on phone.
- All cards full-bleed on phone with 12 px gutters.
- Numeric stat values at minimum 1.6 rem so they're readable without zoom.
- No hover-only affordances. Tap to expand/collapse.
- CSS Grid with `auto-fit minmax(280px, 1fr)` for desktop card layouts.
- Bundle all CSS inline; no external fonts; system font stack only.
- Bundle the CSV ZIP inline as a base64 `data:` URL so the download works
  through the oauth proxy with zero extra round-trips.

## Data model

- **Trial** (planned/in-flight/completed) sourced from L2 JSON outputs at
  `ads/google/outputs/*/json/run-*-l2-output.json`. Fields used:
  `trial_group_name, hypothesis, policy_class, budget, controls, variants,
  success_criteria, expected_insights`.
- **Live status** sourced from the latest snapshot at
  `ads/google/snapshots/ads-snapshot-live.jsonl`. Per-ad fields used:
  `ad_group_name, policy_status, serving_status, ad_status, metrics`.
- **Persistent positive approval** = trial-named ad
  (`*-trial-NNN` in ad_group_name) where `policy_status == approved` AND
  `serving_status == eligible` AND `ad_status == enabled`. Days persisting
  derived from snapshot history when multiple snapshots exist; otherwise
  reported as "≥ today".

## Deploy

`scripts/upload-to-mss <built-html> "gads experiments viz" 86400` →
returns a URL on the oauth-proxied `mss-one-offs` host.
