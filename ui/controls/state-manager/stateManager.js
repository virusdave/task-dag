/**
 * State Manager - Centralized state persistence for pricing review
 * 
 * Manages approval states, price overrides, MSO flags, and hierarchy inheritance.
 * Provides localStorage persistence with auto-save and server sync hooks.
 * 
 * @module ui/controls/state-manager
 */

export const StateManager = (() => {
  'use strict';

  const DEFAULT_OPTIONS = {
    storageKey: 'pricing-review-state',
    autoSaveDelay: 2000,
    onStateChange: null,
    onSave: null
  };

  /**
   * Create a new state manager instance
   * 
   * @param {Object} options - Configuration options
   * @returns {Object} State manager instance
   */
  function create(options = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    
    let state = {
      approvals: {},      // { rowId: 'approved'|'rejected'|'pending' }
      prices: {},         // { rowId: { value, inheritedFrom?, overridden } }
      msoFlags: {},       // { brandId: boolean }
      groupApprovals: {}, // { groupId: 'approved'|'rejected'|'pending' }
      groupPrices: {},    // { groupId: price }
      metadata: {
        lastModified: null,
        lastSaved: null,
        user: null
      }
    };

    let autoSaveTimer = null;
    let isDirty = false;

    /**
     * Load state from localStorage
     */
    function load() {
      try {
        const raw = localStorage.getItem(config.storageKey);
        if (raw) {
          const loaded = JSON.parse(raw);
          state = { ...state, ...loaded };
          isDirty = false;
          return true;
        }
      } catch (e) {
        console.error('Failed to load state:', e);
      }
      return false;
    }

    /**
     * Save state to localStorage
     */
    function save() {
      try {
        state.metadata.lastSaved = new Date().toISOString();
        localStorage.setItem(config.storageKey, JSON.stringify(state));
        isDirty = false;
        
        if (config.onSave) {
          config.onSave(state);
        }
        return true;
      } catch (e) {
        console.error('Failed to save state:', e);
        return false;
      }
    }

    /**
     * Mark state as modified and trigger auto-save
     */
    function markDirty() {
      isDirty = true;
      state.metadata.lastModified = new Date().toISOString();
      
      if (config.onStateChange) {
        config.onStateChange(state);
      }

      // Debounced auto-save
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
      }
      autoSaveTimer = setTimeout(() => {
        save();
      }, config.autoSaveDelay);
    }

    /**
     * Set approval state for a row
     */
    function setApproval(rowId, approvalState) {
      if (state.approvals[rowId] !== approvalState) {
        state.approvals[rowId] = approvalState;
        markDirty();
      }
    }

    /**
     * Get approval state for a row
     */
    function getApproval(rowId) {
      return state.approvals[rowId] || 'pending';
    }

    /**
     * Set price override for a row
     */
    function setPrice(rowId, price, options = {}) {
      const { inheritedFrom = null, overridden = true } = options;
      
      state.prices[rowId] = {
        value: price,
        inheritedFrom,
        overridden,
        timestamp: new Date().toISOString()
      };
      markDirty();
    }

    /**
     * Get price data for a row
     */
    function getPrice(rowId) {
      return state.prices[rowId] || null;
    }

    /**
     * Set group-level approval
     */
    function setGroupApproval(groupId, approvalState, cascadeToRows = false, rowIds = []) {
      state.groupApprovals[groupId] = approvalState;
      
      if (cascadeToRows && rowIds.length > 0) {
        rowIds.forEach(rowId => {
          setApproval(rowId, approvalState);
        });
      }
      
      markDirty();
    }

    /**
     * Set group-level price (cascade to children)
     */
    function setGroupPrice(groupId, price, cascadeToRows = false, rowIds = []) {
      state.groupPrices[groupId] = {
        value: price,
        timestamp: new Date().toISOString()
      };
      
      if (cascadeToRows && rowIds.length > 0) {
        rowIds.forEach(rowId => {
          // Only cascade to rows without explicit overrides
          const existing = state.prices[rowId];
          if (!existing || !existing.overridden) {
            setPrice(rowId, price, {
              inheritedFrom: groupId,
              overridden: false
            });
          }
        });
      }
      
      markDirty();
    }

    /**
     * Set MSO flag for a brand
     */
    function setMSOFlag(brandId, isMSO) {
      state.msoFlags[brandId] = isMSO;
      markDirty();
    }

    /**
     * Get MSO flag for a brand
     */
    function getMSOFlag(brandId) {
      return state.msoFlags[brandId] || false;
    }

    /**
     * Get aggregate statistics
     */
    function getStatistics() {
      const approvalCounts = {
        approved: 0,
        rejected: 0,
        pending: 0
      };
      
      Object.values(state.approvals).forEach(approval => {
        approvalCounts[approval] = (approvalCounts[approval] || 0) + 1;
      });

      const priceOverrideCount = Object.values(state.prices).filter(
        p => p.overridden
      ).length;

      return {
        approvals: approvalCounts,
        priceOverrides: priceOverrideCount,
        msoFlaggedBrands: Object.keys(state.msoFlags).filter(
          id => state.msoFlags[id]
        ).length,
        isDirty,
        lastSaved: state.metadata.lastSaved
      };
    }

    /**
     * Export state for server persistence
     */
    function exportState() {
      return {
        ...state,
        exportedAt: new Date().toISOString()
      };
    }

    /**
     * Import state from server
     */
    function importState(importedState) {
      state = { ...state, ...importedState };
      save();
      markDirty();
    }

    /**
     * Reset all state
     */
    function reset() {
      state = {
        approvals: {},
        prices: {},
        msoFlags: {},
        groupApprovals: {},
        groupPrices: {},
        metadata: {
          lastModified: null,
          lastSaved: null,
          user: null
        }
      };
      save();
      isDirty = false;
    }

    // Auto-load on creation
    load();

    // Public API
    return {
      // Row-level operations
      setApproval,
      getApproval,
      setPrice,
      getPrice,
      
      // Group-level operations
      setGroupApproval,
      setGroupPrice,
      
      // MSO operations
      setMSOFlag,
      getMSOFlag,
      
      // Persistence
      load,
      save,
      exportState,
      importState,
      reset,
      
      // Utilities
      getStatistics,
      getState: () => ({ ...state }),
      isDirty: () => isDirty
    };
  }

  // Public API
  return {
    create
  };
})();

// Auto-initialize as IIFE for inline script usage
if (typeof window !== 'undefined' && !window.StateManager) {
  window.StateManager = StateManager;
}
