import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Shared sidebar subtree for the Ads (communications) module. Any page
 * under /communications/* that wants the common ops leaves (Drive ingest,
 * Price comparison review, etc.) to stay visible should register this via
 * `useRegisterSidebarSubtree('communications', COMMUNICATIONS_SIDEBAR_SUBTREE)`.
 *
 * Page-specific subtrees (e.g. PolicyReplacementReviewPage's anchor-style
 * Review > Assets tree) override this by registering their own subtree.
 *
 * `Price comparison review` (FB-US Midtown/Bronx competitor match review)
 * lives on the mostly-static-sites Next.js app
 * (apps/freshlybakedus-site/app/internal/{midtown,bronx}-conquest/...) and
 * is reached here via external links into the OAuth-gated /internal/
 * subtree on freshlybaked.us. It was previously surfaced under
 * Catalog → Market data review but it's really competitor pricing intel
 * for the ads / merchandising surface, so it lives under Ads now. The
 * longer-term plan is to migrate the matching UI (category/subcategory/
 * variant/brand filters, in-stock vs in-stock-related toggle, mobile-
 * friendly review) into Helios itself, at which point these two external
 * leaves should be replaced with a Helios-native route.
 */
export const COMMUNICATIONS_SIDEBAR_SUBTREE: TreeNavNode[] = [
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
