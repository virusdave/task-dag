/**
 * Competitor Summary - Inline competitive pricing data display
 * 
 * Shows key competitor metrics inline without requiring clicks.
 * Displays median, range, and top competitor price for quick decisions.
 * 
 * @module ui/controls/competitor-summary
 */

export const CompetitorSummary = (() => {
  'use strict';

  /**
   * Create competitor summary display
   * 
   * @param {Object} data
   * @param {number} data.median - Market median price
   * @param {number} data.min - Lowest competitor price
   * @param {number} data.max - Highest competitor price
   * @param {Object} data.topCompetitor - { name, price }
   * @param {number} data.count - Number of competitors
   * @param {Function} options.onViewDetails - Callback to show full competitor list
   * @returns {HTMLElement} Summary element
   */
  function create(data = {}, options = {}) {
    const {
      median = null,
      min = null,
      max = null,
      topCompetitor = null,
      count = 0,
      marketAvg = null
    } = data;

    const { onViewDetails = null } = options;

    const container = document.createElement('div');
    container.className = 'competitor-summary';

    if (count === 0 || (median === null && min === null)) {
      container.innerHTML = '<span class="muted">No competitor data</span>';
      return container;
    }

    const metrics = document.createElement('div');
    metrics.className = 'competitor-metrics';

    // Median
    if (median !== null) {
      const medianSpan = document.createElement('span');
      medianSpan.className = 'competitor-metric competitor-median';
      medianSpan.innerHTML = `Median: <strong>${formatMoney(median)}</strong>`;
      metrics.appendChild(medianSpan);
    }

    // Range
    if (min !== null && max !== null) {
      const rangeSpan = document.createElement('span');
      rangeSpan.className = 'competitor-metric competitor-range';
      rangeSpan.innerHTML = `Range: <strong>${formatMoney(min)}-${formatMoney(max)}</strong>`;
      metrics.appendChild(rangeSpan);
    }

    // Top competitor
    if (topCompetitor && topCompetitor.price !== null) {
      const topSpan = document.createElement('span');
      topSpan.className = 'competitor-metric competitor-top';
      const name = topCompetitor.name || 'Top comp';
      topSpan.innerHTML = `${name}: <strong>${formatMoney(topCompetitor.price)}</strong>`;
      metrics.appendChild(topSpan);
    }

    container.appendChild(metrics);

    // View details button
    if (count > 0 && onViewDetails) {
      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'competitor-view-btn';
      viewBtn.textContent = `View ${count} offer${count === 1 ? '' : 's'}`;
      viewBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onViewDetails();
      });
      container.appendChild(viewBtn);
    }

    return container;
  }

  /**
   * Create position indicator (where our price sits vs competitors)
   * 
   * @param {number} ourPrice - Our proposed price
   * @param {number} median - Market median
   * @param {number} min - Lowest price
   * @param {number} max - Highest price
   * @returns {HTMLElement} Indicator element
   */
  function createPositionIndicator(ourPrice, median, min, max) {
    const container = document.createElement('span');
    container.className = 'price-position-indicator';

    if (!isFinite(ourPrice) || !isFinite(median)) {
      return container;
    }

    const delta = ourPrice - median;
    const percentile = calculatePercentile(ourPrice, min, median, max);

    let label = '';
    let className = '';

    if (Math.abs(delta) < 0.50) {
      label = 'At median';
      className = 'at-median';
    } else if (delta > 0) {
      label = `Above median by ${formatMoney(Math.abs(delta))}`;
      className = 'above-median';
      if (percentile) {
        label += ` (P${Math.round(percentile)})`;
      }
    } else {
      label = `Below median by ${formatMoney(Math.abs(delta))}`;
      className = 'below-median';
      if (percentile) {
        label += ` (P${Math.round(percentile)})`;
      }
    }

    container.textContent = label;
    container.classList.add(className);
    return container;
  }

  /**
   * Calculate approximate percentile position
   */
  function calculatePercentile(price, min, median, max) {
    if (!isFinite(price) || !isFinite(min) || !isFinite(max)) {
      return null;
    }

    if (price <= min) return 0;
    if (price >= max) return 100;

    // Simplified: assume median is P50
    if (price < median) {
      return (price - min) / (median - min) * 50;
    } else {
      return 50 + (price - median) / (max - median) * 50;
    }
  }

  /**
   * Format money
   */
  function formatMoney(value) {
    if (!isFinite(value)) return '$?.??';
    return '$' + value.toFixed(2);
  }

  /**
   * Load CSS
   */
  function loadStyles() {
    if (document.getElementById('competitor-summary-styles')) return;

    const style = document.createElement('style');
    style.id = 'competitor-summary-styles';
    style.textContent = `
      .competitor-summary {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .competitor-metrics {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 12px;
        font-size: 12px;
        color: #6d665b;
      }
      .competitor-metric {
        white-space: nowrap;
      }
      .competitor-metric strong {
        color: #1f1b17;
        font-weight: 700;
      }
      .competitor-median strong {
        color: #27417e;
      }
      .competitor-top strong {
        color: #8a4626;
      }
      .competitor-view-btn {
        align-self: flex-start;
        padding: 4px 10px;
        border: 1px solid #d9ceb7;
        border-radius: 6px;
        background: rgba(255,255,255,0.9);
        font: inherit;
        font-size: 11px;
        color: #294f94;
        text-decoration: none;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .competitor-view-btn:hover {
        background: #fff;
        border-color: #294f94;
        box-shadow: 0 2px 6px rgba(0,0,0,0.08);
      }
      
      /* Position indicator */
      .price-position-indicator {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        background: rgba(0,0,0,0.05);
      }
      .price-position-indicator.at-median {
        background: rgba(39, 65, 126, 0.1);
        color: #27417e;
      }
      .price-position-indicator.above-median {
        background: rgba(138, 70, 38, 0.1);
        color: #8a4626;
      }
      .price-position-indicator.below-median {
        background: rgba(31, 93, 66, 0.1);
        color: #1f5d42;
      }
    `;
    document.head.appendChild(style);
  }

  // Public API
  return {
    create,
    createPositionIndicator,
    loadStyles,
    formatMoney
  };
})();

// Auto-initialize
if (typeof window !== 'undefined' && !window.CompetitorSummary) {
  window.CompetitorSummary = CompetitorSummary;
  CompetitorSummary.loadStyles();
}
