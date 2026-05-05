# Helios UI Standards

These rules are durable, not handoff state. Any new Helios surface (current
modules: `catalog`, `screens`, `pricing`, `scheduling`, `communications` (Ads),
`crm`, `utilities`) must follow them. If a screen needs to deviate, update
this doc first and explain why; do not silently re-introduce a parallel
pattern.

## One Nav Pane To Rule Them All

Helios has exactly **one** primary navigation surface: the left-hand
`PrimarySidebar` in
[`src/client/components/AppShell.tsx`](../../helios/src/client/components/AppShell.tsx),
backed by the canonical `TreeNav` control in
[`src/client/components/TreeNav.tsx`](../../helios/src/client/components/TreeNav.tsx).

Hard rules:

- There is **no** per-page nav rail. Do not add a second sidebar, a per-page
  table-of-contents pane, breadcrumb-rail nav, packet-internal "nav strip", or
  any other separate navigation surface anywhere inside `<main>` content.
  The retired `.review-with-tree-nav` / `.tree-nav-rail` pattern (see the
  comment near the bottom of `src/client/styles/index.css`) is the historical
  example we are deliberately not bringing back.
- Module pages register their own subtree of nav nodes into the primary
  sidebar via `useRegisterSidebarSubtree(<moduleCode>, nodes)` from
  [`SidebarNavContext.tsx`](../../helios/src/client/components/SidebarNavContext.tsx).
  The user navigates within a packet/page using those primary-sidebar leaves,
  not a separate component.
- Section anchors inside a page are reached by primary-sidebar leaves with a
  `targetId` referencing the in-page anchor element id. The page itself owns
  the scroll-spy that updates breadcrumbs from those targets.
- Tree state (open/closed branches, sidebar collapsed) persists in
  `localStorage` under the keys defined in `AppShell.tsx`. Do not invent
  parallel persistence keys.

Nav structure rules:

- Windows-Explorer style. The single root (`Helios`) is the only branch
  expanded by default; every immediate child collapses with `+`. Branch
  labels are themselves clickable navigation targets when they have a `to`
  or `targetId`; toggling expand/collapse is a separate small `+`/`-` box.
- Leaf and branch rows must use the **same vertical row size**. `TreeNav.css`
  enforces this with a shared `min-height: calc(1rem + 0.3rem)` and
  identical row padding (`0.15rem 0.4rem`) on `.tree-nav-row` and
  `.tree-nav-leaf-row`. Do not re-introduce the asymmetric `.tree-nav-leaf-row
  { padding: 0.1rem ... }` shrink-the-leaves pattern from earlier ads work.
- Do not invent extra "Overview" pseudo-leaves alongside a branch that is
  already itself a navigation target.
- Counts go in the trailing `(N)` slot via the `count` field on
  `TreeNavNode`, not as a separate badge.

Anti-patterns to avoid:

- Embedding a `<nav>` element inside `<main>` for "this page's sections".
- Adding a "show / hide review nav" floating button. Sidebar collapse is
  handled by the topbar `Show nav` / `Hide nav` button and `Esc` shortcut.
- Per-packet sidebars styled differently from `TreeNav` (rounded pill chips,
  alternative typography, larger row heights, etc.). All in-page navigation
  uses the canonical `TreeNav` rendering.

## Reviewer Pages

Operator-facing review surfaces (catalog review queue, pricing review
queue, communications policy-replacement review, etc.) must:

- Use the primary sidebar for jumping between sections; never add an
  in-page nav rail.
- Render the rich review evidence (current asset state, proposed change,
  reason/why-safer copy, character counts, association counts, impressions,
  status reasons, replacement options) directly in the per-item card. The
  Helios review surface is not allowed to be a thinner version of the
  standalone HTML packet for the same data; if the standalone packet shows
  it, Helios must show it too.
- Group items into sections matching the sidebar leaves, with stable
  `id="section-<prefix>"` anchors so the sidebar `targetId` deep links work.
- Use the shared `Pill` component for tone-coded status chips.

## Maintenance

If you intentionally change one of the rules above, update this doc first,
then update `TreeNav.tsx` / `AppShell.tsx` / the affected reviewer page in
the same change so the codebase and the rule never disagree.
