# Canonical pricing-ladder

Reusable UI control for visualizing a SKU's price against the local
NYC market and (optionally) letting a reviewer drag a "proposed price"
marker to set/adjust a target.

This is the canonical implementation. Older one-off generators
(`bulk_additions/2026-04-10/.../283862.html`,
`catalog/purchases/2026-05-07/regenerate_review.py`,
`helios/scripts/generateBronxMidtownPricingPacket.ts`) should be migrated
to consume this module instead of carrying their own copies.

## Layout (visual contract)

```
       ┌──────────────────────────────────────────────────────┐  ← markers (live, proposed)
       │                                                      │
band   │  ●  ●●         ●           ←  very-near (≤ 2 mi, deepest green)
band   │      ●     ●●●         ●   ←  near      (2–5 mi)
band   │              ●  ● ●        ←  mid       (5–15 mi)
band   │     ●               ●      ←  far       (15–50 mi)
band   │                  ●   ●     ←  statewide (>50 / unknown)
       │ - - - - - - - - - - - -  ← baseline (price axis)
       │            [ IQR  ]       ← median tick + IQR band
       │                                                      │
       └──────────────────────────────────────────────────────┘
       $axisMin          [Market avg / Median markers]   $axisMax
```

Visual rules:

- **Color = distance band** (5 bands, fixed palette; see `bands.ts`).
- **Vertical position = distance band**, with a within-band micro-adjust:
  the closer dispensaries inside a band sit a few px higher than the
  farther ones inside that same band.
- **Color saturation = within-band proximity**: closer dispensaries inside
  a band keep the band's pure hue; farther ones inside that band fade
  slightly toward white via `color-mix()`.
- **Live / proposed** markers are anchored markers with vertical pin lines
  spanning the track and labels at the top.
- **Market avg / median** markers float at the bottom edge.

## Usage — static HTML packet

```ts
import {
  PRICING_LADDER_STYLE,
  renderPricingLadder,
} from 'helios/src/shared/ui/pricing-ladder/index.js'

const ladderHtml = renderPricingLadder(
  {
    productId: 380052,
    livePrice: 92,
    proposedPrice: null,
    marketAveragePostTax: 56.4,
    marketMedianPostTax: 54.8,
    competitorListings: [
      {
        listingId: 1,
        postTaxPrice: 88.13,
        distanceMiles: 0.67,
        dispensaryName: 'Qube — Manhattan',
        dispensaryAddress: '1412 Broadway',
        listingName: 'Blueberry 2.0 | 510 Cart 2pk | 1g',
        url: 'https://...',
      },
      // ... up to N listings
    ],
  },
  { variant: 'detail', headHtml: '<span class="metric">Current $92 (28% GM)</span>' },
)

const pageHtml = `<!doctype html><html><head><style>${PRICING_LADDER_STYLE}</style></head>
<body>${ladderHtml}</body></html>`
```

The marker is purely visual until you opt in to the slider.

## Usage — slider (interactive proposed price)

```ts
import { attachPricingLadderSlider } from 'helios/src/shared/ui/pricing-ladder/index.js'

const ladderEl = document.querySelector('[data-canonical-pricing-ladder]')!
const detach = attachPricingLadderSlider(ladderEl, (rawPrice, meta) => {
  // Round to nearest quarter so the marker snaps cleanly.
  const snapped = Math.round(rawPrice * 4) / 4
  myReviewForm.setProposedPrice(meta.productId, snapped)
  return snapped // returning a number snaps the marker to that value
})

// later, on unmount:
detach()
```

If `attachPricingLadderSlider` is **not** called, the proposed marker is a
static visual element. This matches the workspace policy:

> The price control needs a slider which may or may not be attached to a
> handler to update proposed pricing. This depends on context, but if a
> handler IS attached then the slider should be slidable.

## Module map

| File          | Purpose |
|---------------|---------|
| `bands.ts`    | 5-tier distance schema, vertical-track positions, color shading |
| `geometry.ts` | Pure layout math (input → positioned points + markers + stats) |
| `style.ts`    | `PRICING_LADDER_STYLE`: self-contained CSS |
| `render.ts`   | HTML-string renderer (works in static packets and SSR) |
| `slider.ts`   | Vanilla pointer-driven drag handler for the proposed marker |
| `index.ts`    | Public re-exports |

## Data attributes (for downstream wiring)

The rendered ladder element exposes:

- `data-canonical-pricing-ladder` (anchor)
- `data-product-id`
- `data-ladder-min`, `data-ladder-max` (numeric domain bounds, post-tax USD)
- `data-variant` (`compact` | `detail`)

Each competitor dot exposes:

- `data-canonical-pricing-ladder-competitor`
- `data-band` (`very-near|near|mid|far|statewide`)
- `data-listing-id`
- `data-eligible` (`true` | `false`)
- `data-distance-miles`
- `data-proximity` (within-band proximity in [0,1])

Each marker exposes:

- `data-canonical-pricing-ladder-marker` (`live|proposed|market-average|market-median`)

## Design lineage

This module merges the most useful properties from three prior generators:

| Source | Contribution |
|---|---|
| `helios/scripts/generateBronxMidtownPricingPacket.ts` (2026-04-18) | drag-to-adjust + data-attribute wiring contract |
| `catalog/purchases/2026-05-07/regenerate_review.py` | 5-band schema + vertical-by-distance positioning + colored-zone gradient track background |
| New for the canonical | within-band proximity factor → color saturation + vertical micro-adjust + `color-mix()` shading |
