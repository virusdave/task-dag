# Tree Nav Control

This control family provides a reusable persisted review-tree nav for packet-style UIs.

## Files

- `renderReviewTreeNav.ts`: shared HTML renderer for generated packet markup
- `reviewTreeNav.js`: shared client runtime for persisted node state, active-link sync, ancestor reveal, and sidebar visibility state

## Intended Use

- Generated static review packets can render the nav with `renderReviewTreeNav()` and initialize the runtime with caller-specific storage keys and navigation callbacks.
- App-backed React pages should treat this as the current behavior contract and may wrap it with a Headless UI implementation when that surface becomes the main consumer.
