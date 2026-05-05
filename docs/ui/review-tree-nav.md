# Review Tree Nav

This doc captures the reusable persisted left-tree nav extracted from the legacy Bronx/Midtown pricing packet.

## Canonical Code

- Shared renderer: `ui/controls/tree-nav/renderReviewTreeNav.ts`
- Shared client runtime: `ui/controls/tree-nav/reviewTreeNav.js`
- Current legacy packet consumer: `helios/scripts/generateBronxMidtownPricingPacket.ts`
- Reference behavior source: `docs/google-ads/review-packets.md` and `ads/google/midtown_conquest_creative_review_2026-05-03/review-client.js`

## Reusable Behavior

- Native `details` nodes collapse independently instead of forcing a single-open accordion.
- Every tree node persists under a stable caller-provided `data-nav-key`.
- The active leaf is highlighted from `window.location.hash`.
- Direct hash loads reopen matching ancestors automatically.
- Whole-sidebar visibility persists separately from tree open or closed state.
- Callers provide the storage-key namespace, the target ids, and the page-specific navigation callback.

## Ownership Boundary

- The shared tree-nav control owns only tree behavior and sidebar visibility behavior.
- It does not own packet review state, draft persistence, row include or reject state, apply submission, or page-specific scrolling targets.
- Consumers should wire their own `onNavigate(targetId)` callback so the control can stay generic.

## When To Reuse It

- Use this control for packet-style or document-style UIs that need a left review tree with stable anchors and persisted collapse state.
- Prefer the shared control over copying nav logic into a new packet generator.
- If a React surface needs the same interaction but can use Headless UI cleanly, keep the shared behavior and persistence contract but consider a Headless UI wrapper instead of reusing the exact static runtime.
