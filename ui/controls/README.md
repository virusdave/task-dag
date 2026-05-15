# UI Controls Library

Modular, reusable UI components for pricing review and catalog management interfaces.

## Philosophy

- **Framework-agnostic**: Vanilla JavaScript, works anywhere
- **Self-contained**: Each module includes its own CSS
- **Reusable**: Drop into any project
- **Accessible**: ARIA labels, keyboard support
- **Modular**: Import only what you need

## Components

### Core Controls

#### [PriceStepControl](price-step/)
Discrete $0.25 price adjustment with keyboard-friendly inputs.
```javascript
const control = PriceStepControl.create({
  initialPrice: 40.00,
  onChange: (newPrice) => console.log(newPrice)
});
```

#### [ApprovalToggle](approval-toggle/)
Tri-state approval/rejection UI for row and group levels.
```javascript
const toggle = ApprovalToggle.create({
  variant: 'row',  // or 'group'
  onChange: (state) => console.log(state)
});
```

#### [StateManager](state-manager/)
Centralized state persistence with auto-save and hierarchy support.
```javascript
const state = StateManager.create({
  storageKey: 'pricing-review',
  autoSaveDelay: 2000
});
```

### Data Display

#### [CompetitorSummary](competitor-summary/)
Inline competitor metrics without requiring clicks.
```javascript
const summary = CompetitorSummary.create({
  median: 40.00,
  min: 35.00,
  max: 50.00
});
```

#### [CompetitorDrawer](competitor-drawer/)
Side panel for detailed competitor data (replaces new tabs).
```javascript
const drawer = CompetitorDrawer.create();
drawer.open(fullCompetitorData);
```

### Navigation

#### [ReviewTreeNav](tree-nav/)
Hierarchical navigation with state persistence.
```javascript
const nav = ReviewTreeNavControl.init({
  root: document.querySelector('.nav-container')
});
```

## Usage Patterns

### Standalone (Inline Script)

```html
<script src="ui/controls/price-step/priceStepControl.js"></script>
<script>
  const control = PriceStepControl.create({ initialPrice: 40 });
  document.body.appendChild(control);
</script>
```

### ES6 Module

```javascript
import { PriceStepControl } from './ui/controls/price-step/priceStepControl.js';

const control = PriceStepControl.create({ initialPrice: 40 });
```

### All-in-One Bundle

For convenience, include all controls:

```html
<script src="ui/controls/bundle.js"></script>
<script>
  const { PriceStepControl, ApprovalToggle, StateManager } = UIControls;
</script>
```

## Integration Example

Complete pricing review workflow:

```javascript
// Initialize state manager
const state = StateManager.create({ storageKey: 'review-2026-05-13' });

// Create price control
const priceControl = PriceStepControl.create({
  initialPrice: state.getPrice(rowId)?.value || 40.00,
  onChange: (newPrice) => {
    state.setPrice(rowId, newPrice, { overridden: true });
  }
});

// Create approval toggle
const approval = ApprovalToggle.create({
  variant: 'row',
  initialState: state.getApproval(rowId),
  onChange: (newState) => {
    state.setApproval(rowId, newState);
  }
});

// Create competitor summary
const compSummary = CompetitorSummary.create(competitorData, {
  onViewDetails: () => {
    const drawer = CompetitorDrawer.getInstance() || CompetitorDrawer.create();
    drawer.open(fullCompetitorData);
  }
});

// Add to row
row.appendChild(approval);
row.appendChild(priceControl);
row.appendChild(compSummary);
```

## Testing

Each component includes example HTML files:
```bash
cd ui/controls/price-step
open example.html
```

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS 14+, Android Chrome 90+)

## License

Internal use only - FreshlyBakedNYC automation tooling.
