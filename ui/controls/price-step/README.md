# Price Step Control

A reusable UI control for setting prices with discrete $0.25 increments.

## Features

- Discrete $0.25 step adjustments (no continuous slider)
- Keyboard-friendly input field
- Plus/minus buttons for quick adjustments
- Automatic price snapping to nearest quarter
- Min/max bounds support
- Enable/disable states
- Accessible ARIA labels

## Usage

### Basic Usage

```html
<script src="ui/controls/price-step/priceStepControl.js"></script>
<script>
  const control = PriceStepControl.create({
    initialPrice: 40.00,
    min: 0,
    max: 100,
    onChange: (newPrice) => {
      console.log('Price changed to:', newPrice);
    }
  });
  
  document.getElementById('container').appendChild(control);
</script>
```

### API Methods

```javascript
// Get current value
const price = control._api.getValue(); // 40.00

// Set value programmatically
control._api.setValue(42.50);

// Update bounds
control._api.setMin(10);
control._api.setMax(200);

// Disable/enable
control._api.disable();
control._api.enable();
```

### Utility Functions

```javascript
// Snap any value to nearest $0.25
const snapped = PriceStepControl.snapToQuarter(39.87); // 40.00

// Format as currency
const formatted = PriceStepControl.formatMoney(40.00); // "$40.00"

// Calculate gross margin
const gm = PriceStepControl.calculateGM(40.00, 15.00, 1.13); // 54.69
```

## Styling

Styles are automatically injected when the module loads. Override with CSS custom properties:

```css
.price-step-control {
  --step-border-color: #d9ceb7;
  --step-focus-color: #8a4626;
  --step-bg: rgba(255,255,255,0.5);
}
```

## Integration with Pricing Ladder

See `integration-example.html` for a complete example of integrating with pricing ladder visualizations.
