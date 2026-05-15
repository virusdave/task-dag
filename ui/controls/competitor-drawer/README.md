# Competitor Drawer Component

Side panel for detailed competitor data display, replacing new-tab navigation to maintain review context.

## Features

- Slide-in drawer (right or left side)
- Full competitor listings with images
- Market summary statistics
- Direct links to ecom pages
- Keyboard accessible (Esc to close)
- Click outside to close
- Singleton pattern (only one drawer instance)
- Mobile responsive (full-width on small screens)

## Usage

```javascript
const drawer = CompetitorDrawer.create({
  position: 'right',  // or 'left'
  width: 420
});

// Open with data
drawer.open({
  summary: {
    median: 40.00,
    avg: 42.15,
    min: 35.00,
    max: 50.00
  },
  competitors: [
    {
      storeName: 'Competitor A',
      price: 38.00,
      brand: 'BrandX',
      category: 'Flower',
      weight: '3.5g',
      distance: '5 miles',
      imageUrl: 'https://...',
      url: 'https://competitor.com/product/...'
    },
    // ... more competitors
  ]
});

// Set title
drawer.setTitle('Booty Shake Ice Cream Swirl 14g');

// Close
drawer.close();

// Check if open
if (drawer.isOpen()) {
  // ...
}
```

## Integration

Works seamlessly with CompetitorSummary:

```javascript
const summary = CompetitorSummary.create(data, {
  onViewDetails: () => {
    const drawer = CompetitorDrawer.getInstance() || CompetitorDrawer.create();
    drawer.setTitle(productName);
    drawer.open(fullCompetitorData);
  }
});
```
