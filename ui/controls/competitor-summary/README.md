# Competitor Summary Component

Inline display of key competitor pricing metrics without requiring clicks.

## Features

- Shows median, range, and top competitor price
- Position indicator (above/below median)
- "View details" button to open drawer
- Compact design for table cells
- No competitor data gracefully

## Usage

```javascript
const summary = CompetitorSummary.create({
  median: 40.00,
  min: 35.00,
  max: 50.00,
  topCompetitor: { name: 'CompetitorA', price: 38.00 },
  count: 8
}, {
  onViewDetails: () => {
    // Open drawer with full competitor list
  }
});

document.querySelector('.product-row td').appendChild(summary);
```

## Position Indicator

```javascript
const indicator = CompetitorSummary.createPositionIndicator(
  42.00,  // our price
  40.00,  // median
  35.00,  // min
  50.00   // max
);
// Shows: "Above median by $2.00 (P60)"
```
