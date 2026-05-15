/**
 * Price Step Control - Discrete $0.25 price adjustment UI
 * 
 * A reusable control for setting prices with discrete $0.25 increments.
 * Replaces continuous sliders with keyboard-friendly step buttons.
 * 
 * @module ui/controls/price-step
 */

export const PriceStepControl = (() => {
  'use strict';

  const QUARTER = 0.25;
  const POST_TAX = 1.13;

  /**
   * Snap price to nearest $0.25
   */
  function snapToQuarter(value) {
    return Math.round(value / QUARTER) * QUARTER;
  }

  /**
   * Format price as currency
   */
  function formatMoney(value) {
    if (!isFinite(value)) return '$?.??';
    return '$' + value.toFixed(2);
  }

  /**
   * Calculate gross margin percentage
   */
  function calculateGM(price, cost, taxRate = POST_TAX) {
    if (!isFinite(cost) || cost <= 0 || price <= 0) {
      return null;
    }
    return (1 - taxRate * cost / price) * 100;
  }

  /**
   * Create step control UI
   * 
   * @param {Object} options
   * @param {number} options.initialPrice - Starting price
   * @param {number} options.min - Minimum allowed price
   * @param {number} options.max - Maximum allowed price
   * @param {Function} options.onChange - Callback(newPrice)
   * @returns {HTMLElement} Control element
   */
  function create(options = {}) {
    const {
      initialPrice = 0,
      min = 0,
      max = Infinity,
      onChange = null
    } = options;

    const container = document.createElement('div');
    container.className = 'price-step-control';

    const decrementBtn = document.createElement('button');
    decrementBtn.type = 'button';
    decrementBtn.className = 'price-step-btn price-step-down';
    decrementBtn.innerHTML = '−<span class="price-step-label">$0.25</span>';
    decrementBtn.title = 'Decrease by $0.25';
    decrementBtn.setAttribute('aria-label', 'Decrease price by $0.25');

    const priceInput = document.createElement('input');
    priceInput.type = 'number';
    priceInput.step = '0.25';
    priceInput.min = min.toString();
    if (max !== Infinity) priceInput.max = max.toString();
    priceInput.className = 'price-step-input';
    priceInput.value = snapToQuarter(initialPrice).toFixed(2);
    priceInput.setAttribute('aria-label', 'Price');

    const incrementBtn = document.createElement('button');
    incrementBtn.type = 'button';
    incrementBtn.className = 'price-step-btn price-step-up';
    incrementBtn.innerHTML = '+<span class="price-step-label">$0.25</span>';
    incrementBtn.title = 'Increase by $0.25';
    incrementBtn.setAttribute('aria-label', 'Increase price by $0.25');

    container.appendChild(decrementBtn);
    container.appendChild(priceInput);
    container.appendChild(incrementBtn);

    // Event handlers
    const notifyChange = (newPrice) => {
      if (onChange && typeof onChange === 'function') {
        onChange(newPrice);
      }
    };

    decrementBtn.addEventListener('click', () => {
      const currentValue = parseFloat(priceInput.value) || 0;
      const newValue = Math.max(min, snapToQuarter(currentValue - QUARTER));
      priceInput.value = newValue.toFixed(2);
      notifyChange(newValue);
    });

    incrementBtn.addEventListener('click', () => {
      const currentValue = parseFloat(priceInput.value) || 0;
      const newValue = Math.min(max, snapToQuarter(currentValue + QUARTER));
      priceInput.value = newValue.toFixed(2);
      notifyChange(newValue);
    });

    priceInput.addEventListener('change', () => {
      let inputValue = parseFloat(priceInput.value);
      if (!isFinite(inputValue)) inputValue = min;
      inputValue = Math.max(min, Math.min(max, inputValue));
      const snappedValue = snapToQuarter(inputValue);
      priceInput.value = snappedValue.toFixed(2);
      notifyChange(snappedValue);
    });

    priceInput.addEventListener('blur', () => {
      const value = parseFloat(priceInput.value) || min;
      priceInput.value = snapToQuarter(value).toFixed(2);
    });

    // Public API
    container._api = {
      getValue: () => parseFloat(priceInput.value) || 0,
      setValue: (newPrice) => {
        const snapped = snapToQuarter(Math.max(min, Math.min(max, newPrice)));
        priceInput.value = snapped.toFixed(2);
      },
      setMin: (newMin) => {
        priceInput.min = newMin.toString();
      },
      setMax: (newMax) => {
        if (newMax !== Infinity) {
          priceInput.max = newMax.toString();
        }
      },
      disable: () => {
        decrementBtn.disabled = true;
        incrementBtn.disabled = true;
        priceInput.disabled = true;
        container.classList.add('price-step-control-disabled');
      },
      enable: () => {
        decrementBtn.disabled = false;
        incrementBtn.disabled = false;
        priceInput.disabled = false;
        container.classList.remove('price-step-control-disabled');
      }
    };

    return container;
  }

  /**
   * Load CSS for this control
   */
  function loadStyles() {
    if (document.getElementById('price-step-control-styles')) return;

    const style = document.createElement('style');
    style.id = 'price-step-control-styles';
    style.textContent = `
      .price-step-control {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px;
        background: rgba(255,255,255,0.5);
        border: 1px solid #d9ceb7;
        border-radius: 8px;
      }
      .price-step-control-disabled {
        opacity: 0.5;
        pointer-events: none;
      }
      .price-step-btn {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 6px 12px;
        font-family: inherit;
        font-size: 16px;
        font-weight: 700;
        background: rgba(255,255,255,0.9);
        border: 1px solid #d9ceb7;
        border-radius: 6px;
        color: #1f1b17;
        cursor: pointer;
        transition: all 0.15s ease;
        min-width: 44px;
      }
      .price-step-btn:hover:not(:disabled) {
        background: #fff;
        border-color: #8a4626;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      }
      .price-step-btn:active:not(:disabled) {
        transform: scale(0.95);
      }
      .price-step-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .price-step-label {
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #6d665b;
      }
      .price-step-input {
        font-family: inherit;
        font-size: 18px;
        font-weight: 700;
        text-align: center;
        padding: 8px 12px;
        border: 2px solid #d9ceb7;
        border-radius: 6px;
        background: #fff;
        color: #8a4626;
        width: 100px;
        transition: border-color 0.15s ease;
      }
      .price-step-input:focus {
        outline: none;
        border-color: #8a4626;
        box-shadow: 0 0 0 3px rgba(138, 70, 38, 0.15);
      }
      .price-step-input:disabled {
        background: #f5f5f5;
        color: #999;
      }
      .price-step-input::-webkit-inner-spin-button,
      .price-step-input::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
    `;
    document.head.appendChild(style);
  }

  // Public API
  return {
    create,
    loadStyles,
    snapToQuarter,
    formatMoney,
    calculateGM,
    QUARTER,
    POST_TAX
  };
})();

// Auto-initialize as IIFE for inline script usage
if (typeof window !== 'undefined' && !window.PriceStepControl) {
  window.PriceStepControl = PriceStepControl;
  PriceStepControl.loadStyles();
}
