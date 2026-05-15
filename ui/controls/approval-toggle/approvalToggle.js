/**
 * Approval Toggle Control - Tri-state approval/rejection UI
 * 
 * A reusable control for approve/reject/pending states.
 * Supports row-level and group-level approvals with visual feedback.
 * 
 * @module ui/controls/approval-toggle
 */

export const ApprovalToggle = (() => {
  'use strict';

  const STATES = {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected'
  };

  /**
   * Create approval toggle UI
   * 
   * @param {Object} options
   * @param {string} options.initialState - 'pending'|'approved'|'rejected'
   * @param {string} options.variant - 'row'|'group'
   * @param {Function} options.onChange - Callback(newState)
   * @param {string} options.label - Optional label text
   * @returns {HTMLElement} Control element
   */
  function create(options = {}) {
    const {
      initialState = STATES.PENDING,
      variant = 'row',
      onChange = null,
      label = ''
    } = options;

    const container = document.createElement('div');
    container.className = `approval-toggle approval-toggle-${variant}`;
    container.setAttribute('data-approval-state', initialState);

    if (variant === 'row') {
      // Compact icon-only buttons for table rows
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.className = 'approval-btn approval-approve';
      approveBtn.innerHTML = '✓';
      approveBtn.title = 'Approve';
      approveBtn.setAttribute('aria-label', 'Approve');

      const rejectBtn = document.createElement('button');
      rejectBtn.type = 'button';
      rejectBtn.className = 'approval-btn approval-reject';
      rejectBtn.innerHTML = '✕';
      rejectBtn.title = 'Reject';
      rejectBtn.setAttribute('aria-label', 'Reject');

      container.appendChild(approveBtn);
      container.appendChild(rejectBtn);

      approveBtn.addEventListener('click', () => {
        const newState = initialState === STATES.APPROVED ? STATES.PENDING : STATES.APPROVED;
        setState(container, newState);
        if (onChange) onChange(newState);
      });

      rejectBtn.addEventListener('click', () => {
        const newState = initialState === STATES.REJECTED ? STATES.PENDING : STATES.REJECTED;
        setState(container, newState);
        if (onChange) onChange(newState);
      });

    } else {
      // Full-sized buttons for group summaries
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.className = 'approval-btn-pill approval-approve-all';
      approveBtn.textContent = 'Approve all';
      approveBtn.setAttribute('aria-label', `Approve all ${label}`);

      const rejectBtn = document.createElement('button');
      rejectBtn.type = 'button';
      rejectBtn.className = 'approval-btn-pill approval-reject-all';
      rejectBtn.textContent = 'Reject all';
      rejectBtn.setAttribute('aria-label', `Reject all ${label}`);

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'approval-btn-link approval-clear';
      clearBtn.textContent = 'Clear';
      clearBtn.setAttribute('aria-label', `Clear approval status for ${label}`);

      container.appendChild(approveBtn);
      container.appendChild(rejectBtn);
      container.appendChild(clearBtn);

      approveBtn.addEventListener('click', () => {
        setState(container, STATES.APPROVED);
        if (onChange) onChange(STATES.APPROVED);
      });

      rejectBtn.addEventListener('click', () => {
        setState(container, STATES.REJECTED);
        if (onChange) onChange(STATES.REJECTED);
      });

      clearBtn.addEventListener('click', () => {
        setState(container, STATES.PENDING);
        if (onChange) onChange(STATES.PENDING);
      });
    }

    // Initialize state visual
    setState(container, initialState);

    // Public API
    container._api = {
      getState: () => container.getAttribute('data-approval-state'),
      setState: (newState) => setState(container, newState),
      disable: () => {
        container.querySelectorAll('button').forEach(btn => btn.disabled = true);
        container.classList.add('approval-toggle-disabled');
      },
      enable: () => {
        container.querySelectorAll('button').forEach(btn => btn.disabled = false);
        container.classList.remove('approval-toggle-disabled');
      }
    };

    return container;
  }

  /**
   * Set visual state of approval toggle
   */
  function setState(container, newState) {
    container.setAttribute('data-approval-state', newState);
    
    // Update button pressed states for row variant
    const approveBtn = container.querySelector('.approval-approve');
    const rejectBtn = container.querySelector('.approval-reject');
    
    if (approveBtn && rejectBtn) {
      approveBtn.setAttribute('aria-pressed', newState === STATES.APPROVED);
      rejectBtn.setAttribute('aria-pressed', newState === STATES.REJECTED);
    }
  }

  /**
   * Create status badge (for displaying aggregate approval state)
   * 
   * @param {Object} options
   * @param {number} options.approved - Count of approved items
   * @param {number} options.rejected - Count of rejected items
   * @param {number} options.total - Total items
   * @returns {HTMLElement} Badge element
   */
  function createStatusBadge(options = {}) {
    const { approved = 0, rejected = 0, total = 0 } = options;
    const pending = total - approved - rejected;

    const badge = document.createElement('span');
    badge.className = 'approval-status-badge';

    let state = STATES.PENDING;
    let text = `${pending} pending`;

    if (approved === total && total > 0) {
      state = STATES.APPROVED;
      text = `✓ Approved · ${approved}/${total}`;
    } else if (rejected === total && total > 0) {
      state = STATES.REJECTED;
      text = `✕ Rejected · ${rejected}/${total}`;
    } else if (approved > 0 || rejected > 0) {
      state = 'mixed';
      text = `Partial · ${approved} ✓ ${rejected} ✕`;
    }

    badge.setAttribute('data-approval-state', state);
    badge.textContent = text;

    return badge;
  }

  /**
   * Load CSS for this control
   */
  function loadStyles() {
    if (document.getElementById('approval-toggle-styles')) return;

    const style = document.createElement('style');
    style.id = 'approval-toggle-styles';
    style.textContent = `
      .approval-toggle {
        display: inline-flex;
        gap: 4px;
        align-items: center;
      }
      .approval-toggle-row {
        gap: 2px;
      }
      .approval-toggle-group {
        gap: 6px;
      }
      .approval-toggle-disabled {
        opacity: 0.5;
        pointer-events: none;
      }
      
      /* Row variant - compact icon buttons */
      .approval-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1.5px solid #d9ceb7;
        border-radius: 4px;
        background: #fff;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .approval-btn:hover:not(:disabled) {
        border-color: currentColor;
        box-shadow: 0 2px 6px rgba(0,0,0,0.1);
      }
      .approval-approve {
        color: #1f5d42;
      }
      .approval-approve[aria-pressed="true"] {
        background: #1f5d42;
        color: #fff;
        border-color: #1f5d42;
      }
      .approval-reject {
        color: #8d2f52;
      }
      .approval-reject[aria-pressed="true"] {
        background: #8d2f52;
        color: #fff;
        border-color: #8d2f52;
      }
      
      /* Group variant - pill buttons */
      .approval-btn-pill {
        padding: 6px 14px;
        border: 1px solid #d9ceb7;
        border-radius: 999px;
        background: rgba(255,255,255,0.9);
        font: inherit;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .approval-approve-all {
        color: #1f5d42;
        border-color: rgba(31, 93, 66, 0.3);
      }
      .approval-approve-all:hover:not(:disabled) {
        background: #1f5d42;
        color: #fff;
        border-color: #1f5d42;
      }
      .approval-reject-all {
        color: #8d2f52;
        border-color: rgba(141, 47, 82, 0.3);
      }
      .approval-reject-all:hover:not(:disabled) {
        background: #8d2f52;
        color: #fff;
        border-color: #8d2f52;
      }
      .approval-btn-link {
        padding: 6px 10px;
        border: none;
        background: transparent;
        font: inherit;
        font-size: 12px;
        color: #6d665b;
        text-decoration: underline;
        cursor: pointer;
      }
      .approval-btn-link:hover:not(:disabled) {
        color: #1f1b17;
      }
      
      /* Status badge */
      .approval-status-badge {
        display: inline-flex;
        align-items: center;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #fff;
      }
      .approval-status-badge[data-approval-state="pending"] {
        background: #6d665b;
      }
      .approval-status-badge[data-approval-state="approved"] {
        background: #1f5d42;
      }
      .approval-status-badge[data-approval-state="rejected"] {
        background: #8d2f52;
      }
      .approval-status-badge[data-approval-state="mixed"] {
        background: #8b5e11;
      }
      
      /* Row state backgrounds */
      .product-row[data-approval-state="approved"] {
        background-color: rgba(31, 93, 66, 0.05);
      }
      .product-row[data-approval-state="rejected"] {
        background-color: rgba(141, 47, 82, 0.05);
      }
    `;
    document.head.appendChild(style);
  }

  // Public API
  return {
    create,
    createStatusBadge,
    loadStyles,
    STATES
  };
})();

// Auto-initialize as IIFE for inline script usage
if (typeof window !== 'undefined' && !window.ApprovalToggle) {
  window.ApprovalToggle = ApprovalToggle;
  ApprovalToggle.loadStyles();
}
