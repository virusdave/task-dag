# Pricing Review UI Enhancement - Implementation Plan

## Task DAG Structure

This document defines the task breakdown for implementing the pricing review UI enhancements based on Oracle's UX recommendations.

## Tasks (in dependency order)

### Phase 1: Core Infrastructure (Independent)
1. **ui-fix-nav-sidebar** ✅ DONE
   - Fix nav sidebar hide/show CSS bug
   - Change grid-template-columns from `0 1fr` to `1fr` when hidden

2. **ui-discrete-price-controls**
   - Replace draggable price slider with discrete step controls
   - Add -$0.25 / input / +$0.25 button group
   - Enforce $0.25 rounding on all price inputs
   - Update CSS for compact inline layout

3. **ui-approval-row-controls**
   - Add approve/reject toggle buttons to each product row
   - Add CSS for approval states (approved=green, rejected=red, pending=default)
   - Add data attributes for state tracking

4. **ui-competitor-inline-summary**
   - Add competitor summary column to product tables
   - Show: market median, range, top competitor price
   - Use muted text styling for compact display

5. **ui-state-data-model**
   - Create JavaScript state management module
   - Define data structures for: approvals, prices, MSO flags, overrides
   - Implement localStorage persistence layer

### Phase 2: Hierarchy Controls (Depends on Phase 1)

6. **ui-group-approval-controls** (depends: ui-approval-row-controls)
   - Add approval action buttons to group summary bars
   - "Approve all" / "Reject all" / "Clear" buttons
   - Show aggregate status chips (X/Y approved)
   - Wire up cascade logic from group to rows

7. **ui-group-price-controls** (depends: ui-discrete-price-controls, ui-state-data-model)
   - Add price input controls to group summaries
   - "Set price for all in this group" UI
   - Show affected item count
   - Style to match existing group summary design

8. **ui-price-cascade-confirmation** (depends: ui-group-price-controls)
   - Add inline confirmation callout under group summaries
   - Show: target price, affected count, MSO warning count
   - Apply/Cancel buttons
   - Handle inheritance vs override logic

9. **ui-price-inheritance-badges** (depends: ui-price-cascade-confirmation)
   - Add "From Category" / "Override" badges to row prices
   - Use chain/broken-chain icons
   - Muted styling for inherited, bold for overrides

### Phase 3: Enhanced Data & Interactions

10. **ui-competitor-drawer** (depends: ui-competitor-inline-summary)
    - Create fixed right-side drawer component
    - Load on row selection (not new tab)
    - Show full competitor table, images, links
    - Add toggle to collapse drawer

11. **ui-mso-brand-marking** (depends: ui-state-data-model)
    - Add MSO toggle chip to brand-level summaries
    - Persist MSO flags in state
    - Add warning styling (existing .chip.warning)
    - Show MSO badge on affected rows

12. **ui-mso-confirmation** (depends: ui-mso-brand-marking, ui-price-cascade-confirmation)
    - Enhance cascade confirmation to detect MSO brands
    - Show "Affects X MSO brands: [list]" warning
    - Require explicit confirmation

13. **ui-auto-save** (depends: ui-state-data-model)
    - Implement debounced auto-save (localStorage)
    - Update submit bar with "Last saved X min ago"
    - Add "Save draft" button for server persistence
    - Show toast on save

### Phase 4: Power User Features

14. **ui-keyboard-shortcuts** (depends: ui-approval-row-controls, ui-discrete-price-controls)
    - Implement arrow key navigation (↑↓ for rows)
    - Implement price adjustment (←→ for ±$0.25)
    - Implement approval shortcuts (A/R for approve/reject)
    - Add hints UI: "Press ? for shortcuts"
    - Add keyboard shortcut help modal

15. **ui-visual-state-indicators** (depends: ui-approval-row-controls, ui-price-inheritance-badges)
    - Add row background colors for approval states
    - Add progress indicators to nav tree (X/Y completed)
    - Add filter/view controls (show only pending, etc.)

## Commit Strategy

Each task = 1 commit with format:
```
[ui-enhancement] <task-name>: <brief description>

<detailed explanation>
<oracle recommendation reference>

Task: <task-id>
```

## Testing Checklist per Task

- [ ] Visual inspection in browser
- [ ] CSS doesn't break responsive layout
- [ ] JavaScript has no console errors
- [ ] State persists across page reload (if applicable)
- [ ] Works with existing tree nav expand/collapse

## Rollback Strategy

Each commit is atomic and can be reverted independently, except where explicit dependencies exist (noted above).

To revert a task:
```bash
git revert <commit-hash>
```

To revert a chain:
```bash
git revert <newest-hash>^..<oldest-hash>
```
