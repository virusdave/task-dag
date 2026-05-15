# Approval Toggle Control

A reusable tri-state approval/rejection UI control.

## Features

- Three states: pending, approved, rejected
- Two variants: compact row buttons, full group buttons
- Visual feedback with color coding
- Status badges for aggregate display
- Accessible ARIA labels
- Enable/disable support

## Usage

### Row Variant (Compact)

```javascript
const rowToggle = ApprovalToggle.create({
  initialState: 'pending',
  variant: 'row',
  onChange: (newState) => {
    console.log('Approval state:', newState);
  }
});

document.querySelector('.product-row td').appendChild(rowToggle);
```

### Group Variant (Full Buttons)

```javascript
const groupToggle = ApprovalToggle.create({
  initialState: 'pending',
  variant: 'group',
  label: 'Pre-Packaged Flower',
  onChange: (newState) => {
    if (newState === 'approved') {
      // Approve all children
    }
  }
});

document.querySelector('.group-summary').appendChild(groupToggle);
```

### Status Badge

```javascript
const badge = ApprovalToggle.createStatusBadge({
  approved: 5,
  rejected: 2,
  total: 10
});

document.querySelector('.group-count').appendChild(badge);
```

## States

- `ApprovalToggle.STATES.PENDING` - Default neutral state
- `ApprovalToggle.STATES.APPROVED` - Green checkmark
- `ApprovalToggle.STATES.REJECTED` - Red X

## API

```javascript
// Get current state
const state = toggle._api.getState(); // 'approved'

// Set state programmatically
toggle._api.setState('rejected');

// Disable/enable
toggle._api.disable();
toggle._api.enable();
```
