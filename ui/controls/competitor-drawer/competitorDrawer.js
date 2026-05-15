/**
 * Competitor Drawer - Side panel for detailed competitor data
 * 
 * Replaces new-tab navigation with in-page drawer to maintain review context.
 * Shows full competitor listings, images, and direct links to ecom pages.
 * 
 * @module ui/controls/competitor-drawer
 */

export const CompetitorDrawer = (() => {
  'use strict';

  let drawerInstance = null;

  /**
   * Create (or get existing) drawer instance
   * 
   * @param {Object} options
   * @param {string} options.position - 'right'|'left'
   * @param {number} options.width - Drawer width in pixels
   * @returns {Object} Drawer API
   */
  function create(options = {}) {
    if (drawerInstance) {
      return drawerInstance;
    }

    const config = {
      position: options.position || 'right',
      width: options.width || 420
    };

    // Create drawer element
    const drawer = document.createElement('aside');
    drawer.className = `competitor-drawer competitor-drawer-${config.position}`;
    drawer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('aria-label', 'Competitor details');
    drawer.style.width = config.width + 'px';

    // Header
    const header = document.createElement('div');
    header.className = 'competitor-drawer-header';
    header.innerHTML = `
      <h3 class="competitor-drawer-title">Competitor Data</h3>
      <button type="button" class="competitor-drawer-close" aria-label="Close drawer">✕</button>
    `;
    drawer.appendChild(header);

    // Content area
    const content = document.createElement('div');
    content.className = 'competitor-drawer-content';
    drawer.appendChild(content);

    // Add to DOM
    document.body.appendChild(drawer);

    // Close button handler
    const closeBtn = header.querySelector('.competitor-drawer-close');
    closeBtn.addEventListener('click', () => close());

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !drawer.getAttribute('aria-hidden')) {
        close();
      }
    });

    // Click outside to close
    drawer.addEventListener('click', (e) => {
      if (e.target === drawer) {
        close();
      }
    });

    /**
     * Open drawer with content
     */
    function open(data = {}) {
      content.innerHTML = renderContent(data);
      drawer.setAttribute('aria-hidden', 'false');
      document.body.classList.add('competitor-drawer-open');
      
      // Trap focus
      const focusable = content.querySelectorAll(
        'button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length > 0) {
        focusable[0].focus();
      }
    }

    /**
     * Close drawer
     */
    function close() {
      drawer.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('competitor-drawer-open');
      content.innerHTML = '';
    }

    /**
     * Update title
     */
    function setTitle(title) {
      const titleEl = header.querySelector('.competitor-drawer-title');
      titleEl.textContent = title;
    }

    /**
     * Render drawer content
     */
    function renderContent(data) {
      if (!data.competitors || data.competitors.length === 0) {
        return '<div class="competitor-drawer-empty">No competitor data available</div>';
      }

      let html = '';

      // Summary section
      if (data.summary) {
        html += '<div class="competitor-drawer-section">';
        html += '<h4>Market Summary</h4>';
        html += '<div class="competitor-summary-grid">';
        if (data.summary.median !== null) {
          html += `<div class="summary-item"><span class="label">Median</span><strong>${formatMoney(data.summary.median)}</strong></div>`;
        }
        if (data.summary.avg !== null) {
          html += `<div class="summary-item"><span class="label">Average</span><strong>${formatMoney(data.summary.avg)}</strong></div>`;
        }
        if (data.summary.min !== null && data.summary.max !== null) {
          html += `<div class="summary-item"><span class="label">Range</span><strong>${formatMoney(data.summary.min)} - ${formatMoney(data.summary.max)}</strong></div>`;
        }
        html += '</div></div>';
      }

      // Competitor list
      html += '<div class="competitor-drawer-section">';
      html += `<h4>Competitors (${data.competitors.length})</h4>`;
      html += '<div class="competitor-list">';

      data.competitors.forEach(comp => {
        html += '<div class="competitor-item">';
        
        // Image if available
        if (comp.imageUrl) {
          html += `<div class="competitor-image"><img src="${escapeHtml(comp.imageUrl)}" alt="${escapeHtml(comp.storeName || 'Product')}" loading="lazy" /></div>`;
        }
        
        html += '<div class="competitor-details">';
        html += `<div class="competitor-store">${escapeHtml(comp.storeName || 'Unknown Store')}</div>`;
        html += `<div class="competitor-price">${formatMoney(comp.price)}</div>`;
        
        if (comp.brand || comp.category || comp.weight) {
          html += '<div class="competitor-meta">';
          if (comp.brand) html += `<span>${escapeHtml(comp.brand)}</span>`;
          if (comp.category) html += `<span>${escapeHtml(comp.category)}</span>`;
          if (comp.weight) html += `<span>${escapeHtml(comp.weight)}</span>`;
          html += '</div>';
        }
        
        if (comp.distance) {
          html += `<div class="competitor-distance">${escapeHtml(comp.distance)}</div>`;
        }
        
        if (comp.url) {
          html += `<a href="${escapeHtml(comp.url)}" target="_blank" rel="noopener noreferrer" class="competitor-link">View on site →</a>`;
        }
        
        html += '</div></div>';
      });

      html += '</div></div>';

      return html;
    }

    /**
     * Format money
     */
    function formatMoney(value) {
      if (!isFinite(value)) return '$?.??';
      return '$' + value.toFixed(2);
    }

    /**
     * Escape HTML
     */
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Public API
    drawerInstance = {
      open,
      close,
      setTitle,
      isOpen: () => drawer.getAttribute('aria-hidden') === 'false',
      getElement: () => drawer
    };

    return drawerInstance;
  }

  /**
   * Load CSS
   */
  function loadStyles() {
    if (document.getElementById('competitor-drawer-styles')) return;

    const style = document.createElement('style');
    style.id = 'competitor-drawer-styles';
    style.textContent = `
      .competitor-drawer {
        position: fixed;
        top: 0;
        bottom: 0;
        z-index: 1000;
        background: #fffaf1;
        border-left: 1px solid #d9ceb7;
        box-shadow: -4px 0 24px rgba(0,0,0,0.15);
        transform: translateX(100%);
        transition: transform 0.3s ease;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
      }
      .competitor-drawer-right {
        right: 0;
      }
      .competitor-drawer-left {
        left: 0;
        border-left: none;
        border-right: 1px solid #d9ceb7;
        box-shadow: 4px 0 24px rgba(0,0,0,0.15);
        transform: translateX(-100%);
      }
      .competitor-drawer[aria-hidden="false"] {
        transform: translateX(0);
      }
      body.competitor-drawer-open {
        overflow: hidden;
      }
      
      /* Header */
      .competitor-drawer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid #d9ceb7;
        background: #f8f1e5;
      }
      .competitor-drawer-title {
        margin: 0;
        font-size: 16px;
        font-weight: 700;
        color: #1f1b17;
      }
      .competitor-drawer-close {
        width: 32px;
        height: 32px;
        padding: 0;
        border: none;
        background: transparent;
        font-size: 20px;
        color: #6d665b;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.15s ease;
      }
      .competitor-drawer-close:hover {
        background: rgba(0,0,0,0.05);
        color: #1f1b17;
      }
      
      /* Content */
      .competitor-drawer-content {
        flex: 1;
        padding: 20px;
        overflow-y: auto;
      }
      .competitor-drawer-empty {
        padding: 40px 20px;
        text-align: center;
        color: #6d665b;
      }
      .competitor-drawer-section {
        margin-bottom: 24px;
      }
      .competitor-drawer-section h4 {
        margin: 0 0 12px;
        font-size: 14px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #6d665b;
      }
      
      /* Summary grid */
      .competitor-summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 12px;
        padding: 12px;
        background: rgba(255,255,255,0.6);
        border: 1px solid #d9ceb7;
        border-radius: 8px;
      }
      .summary-item {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .summary-item .label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #6d665b;
      }
      .summary-item strong {
        font-size: 16px;
        color: #1f1b17;
      }
      
      /* Competitor list */
      .competitor-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .competitor-item {
        display: flex;
        gap: 12px;
        padding: 12px;
        background: #fff;
        border: 1px solid #d9ceb7;
        border-radius: 8px;
        transition: box-shadow 0.15s ease;
      }
      .competitor-item:hover {
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      }
      .competitor-image {
        flex-shrink: 0;
        width: 80px;
        height: 80px;
        border-radius: 6px;
        overflow: hidden;
        background: #f8f1e5;
      }
      .competitor-image img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .competitor-details {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .competitor-store {
        font-weight: 700;
        color: #1f1b17;
        font-size: 13px;
      }
      .competitor-price {
        font-size: 18px;
        font-weight: 700;
        color: #8a4626;
      }
      .competitor-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        font-size: 11px;
        color: #6d665b;
      }
      .competitor-meta span {
        padding: 2px 6px;
        background: rgba(0,0,0,0.04);
        border-radius: 3px;
      }
      .competitor-distance {
        font-size: 11px;
        color: #6d665b;
      }
      .competitor-link {
        margin-top: 4px;
        font-size: 12px;
        color: #294f94;
        text-decoration: none;
        align-self: flex-start;
      }
      .competitor-link:hover {
        text-decoration: underline;
      }
      
      /* Responsive */
      @media (max-width: 768px) {
        .competitor-drawer {
          width: 100% !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // Public API
  return {
    create,
    loadStyles,
    getInstance: () => drawerInstance
  };
})();

// Auto-initialize
if (typeof window !== 'undefined' && !window.CompetitorDrawer) {
  window.CompetitorDrawer = CompetitorDrawer;
  CompetitorDrawer.loadStyles();
}
