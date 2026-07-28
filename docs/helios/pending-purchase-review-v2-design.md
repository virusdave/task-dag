# Pending-purchase review v2

Status: Oracle-reviewed implementation baseline for automation#107. The emergency local-only implementation directive superseded the original wait-for-approval gate; this document does not represent production approval.

## Operator workflow

The surface follows the operator's current decision rather than exposing packet lifecycle mechanics:

1. **Choose work** — start a packet or continue one outstanding packet. Completed and abandoned work stays secondary.
2. **Wait for generation** — replace unrelated page controls with generation state, progress, elapsed timing, and worker details.
3. **Review one packet** — show packet completion counts and every line item. Pending rows are expanded; accepted and rejected rows collapse to a clearly labelled summary.
4. **Compose a refinement** — select any combination of families and individual rows, add feedback, and submit from a focused refinement surface.
5. **Wait for refinement** — hide stale row controls and show the turn state, selected-row count, submitted feedback, timing, and worker details.
6. **Compare the proposal** — show a complete effective-value diff grouped by row, including selected rows for which no change was proposed. The only primary decision is **Use this update** or **Keep current packet**.
7. **Review the accepted update** — accepting a candidate opens its complete row review. It does not apply catalog changes.
8. **Apply accepted rows** — replace review controls with per-row progress, failures, remediation details, and worker details until the request terminates.

## Information hierarchy

- Keep the current task, state, primary decision, and decision-critical canonical product data visible.
- Keep product hierarchy visible by default. Put provenance, market evidence, methodology, and raw diagnostics behind disclosures.
- Never show packet generation controls while comparing a refinement or waiting on generation/refinement/apply work.
- Label values as current or proposed in comparisons. An edit outside comparison always affects the packet named by the focused review.
- On narrow screens, preserve 44-pixel action targets, stack decisions vertically, and retain side-by-side current/proposed values where they remain readable.

## Oracle review findings incorporated

Oracle found that the existing APIs support the core generation, review, scoped refinement, comparison, candidate selection, and apply states. It recommended a dedicated state surface for each and warned against retaining the normal page beneath an in-progress or candidate decision.

The comparison must use **effective** values (operator edit before generated value), not raw generated columns. It must show unchanged scoped rows so ignored feedback is immediately visible. Unsupported catalog-product links remain validation errors and disabled products must not be offered as selectable targets.

## Backend work intentionally not simulated

The following requirements need durable server contracts and remain follow-up work rather than misleading client-only placeholders:

- discovery of recent uninspected purchases and multi-purchase packet generation;
- concurrent live packets and packet abandonment;
- refinement file attachments;
- detailed per-row refinement progress;
- exact redacted LLM request/response, repair, validation, deterministic override, and final-row derivation diagnostics.

Admin observability for the final item is tracked separately by automation#106.

## Validation gate before production

Capture the implemented surface at desktop and mobile widths for generation, row review, refinement progress, proposal comparison, and apply progress. Verify keyboard focus, screen-reader status announcements, touch targets, overflow for long values, complete effective-value diffs, and an end-to-end candidate accept/keep-current cycle before deployment.
