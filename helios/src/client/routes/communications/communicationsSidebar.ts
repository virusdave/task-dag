import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Shared sidebar subtree for the Ads (communications) module.
 *
 * The AppShell renders the static base subtree (returned by
 * `buildCommunicationsSidebarSubtree()`) so every operator sees Drive
 * ingest / Cluster proposals / Price comparison review immediately on
 * first load. Pages that need extra anchor-style nav (e.g. the policy-
 * limited replacement review) call
 * `buildCommunicationsSidebarSubtree({ extraChildren: [...] })` so they
 * augment the base instead of replacing it (which previously hid the
 * common Ads leaves while inside a packet review).
 *
 * `Price comparison review` (FB-US Midtown/Bronx competitor match review)
 * still lives on the mostly-static-sites Next.js app
 * (apps/freshlybakedus-site/app/internal/{midtown,bronx}-conquest/...) and
 * is reached here via external links into the OAuth-gated /internal/
 * subtree on freshlybaked.us.
 */
export interface CommunicationsSidebarOptions {
  /**
   * Extra leaves / branches appended after the canonical base subtree.
   * Used by page-specific review surfaces (e.g. a packet review page) to
   * surface their own in-page anchors without losing the shared module
   * navigation.
   */
  extraChildren?: TreeNavNode[]
}

export function buildCommunicationsSidebarSubtree(
  options?: CommunicationsSidebarOptions,
): TreeNavNode[] {
  const base: TreeNavNode[] = [
    {
      kind: 'leaf',
      navKey: 'communications.drive-ingest',
      label: 'Drive ingest',
      to: '/communications/drive-ingest',
    },
    {
      kind: 'leaf',
      navKey: 'communications.cluster-proposals',
      label: 'Cluster proposals',
      to: '/communications/cluster-proposals',
    },
    {
      kind: 'branch',
      navKey: 'communications.price-comparison-review',
      label: 'Price comparison review',
      defaultOpen: false,
      children: [
        {
          kind: 'leaf',
          navKey: 'communications.price-comparison-review.midtown',
          label: 'FB-US Midtown competitor matches (MSS)',
          externalHref:
            'https://freshlybaked.us/internal/midtown-conquest/conquest-index.html',
        },
        {
          kind: 'leaf',
          navKey: 'communications.price-comparison-review.bronx',
          label: 'FB-US Bronx competitor matches (MSS)',
          externalHref:
            'https://freshlybaked.us/internal/bronx-conquest/conquest-index.html',
        },
      ],
    },
  ]
  if (options?.extraChildren && options.extraChildren.length > 0) {
    return [...base, ...options.extraChildren]
  }
  return base
}

/**
 * Back-compat constant for callers that just want the base subtree without
 * building it dynamically. Prefer `buildCommunicationsSidebarSubtree()`
 * for new code.
 */
export const COMMUNICATIONS_SIDEBAR_SUBTREE: TreeNavNode[] =
  buildCommunicationsSidebarSubtree()
