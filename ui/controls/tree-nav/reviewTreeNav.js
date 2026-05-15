(function (global) {
  function loadJsonStorage(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) {
        return fallback
      }
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : fallback
    } catch {
      return fallback
    }
  }

  function defaultCurrentTargetId() {
    return decodeURIComponent((window.location.hash || '').replace(/^#/, ''))
  }

  function init(options) {
    const root = options && options.root ? options.root : document
    const detailSelector = options && options.detailSelector ? options.detailSelector : 'details[data-nav-key]'
    const itemSelector = options && options.itemSelector ? options.itemSelector : '[data-review-tree-nav-item]'
    const linkSelector = options && options.linkSelector ? options.linkSelector : '[data-review-tree-nav-link]'
    const targetAttribute = options && options.targetAttribute ? options.targetAttribute : 'data-review-tree-nav-target-id'
    const hideButtonSelector = options && options.hideButtonSelector ? options.hideButtonSelector : '[data-review-tree-nav-hide]'
    const showButtonSelector = options && options.showButtonSelector ? options.showButtonSelector : '[data-review-tree-nav-show]'
    const navStorageKey = options && options.navStorageKey ? options.navStorageKey : ''
    const sidebarStorageKey = options && options.sidebarStorageKey ? options.sidebarStorageKey : ''
    const sidebarHiddenTarget = options && options.sidebarHiddenTarget ? options.sidebarHiddenTarget : document.body
    const sidebarHiddenClassName = options && options.sidebarHiddenClassName ? options.sidebarHiddenClassName : 'nav-hidden'
    const getCurrentTargetId = options && typeof options.getCurrentTargetId === 'function'
      ? options.getCurrentTargetId
      : defaultCurrentTargetId

    const details = Array.from(root.querySelectorAll(detailSelector))
    const items = Array.from(root.querySelectorAll(itemSelector))
    const links = Array.from(root.querySelectorAll(linkSelector))
    const hideButtons = Array.from(root.querySelectorAll(hideButtonSelector))
    const showButtons = Array.from(root.querySelectorAll(showButtonSelector))
    const defaultOpenByKey = new Map()

    details.forEach((detail) => {
      const navKey = detail.getAttribute('data-nav-key') || ''
      if (navKey) {
        defaultOpenByKey.set(navKey, detail.open === true)
      }
    })

    const navState = navStorageKey ? { ...loadJsonStorage(navStorageKey, {}) } : {}
    const loadSidebarHidden = () => {
      if (options && typeof options.loadSidebarHidden === 'function') {
        return options.loadSidebarHidden()
      }
      if (!sidebarStorageKey) {
        return sidebarHiddenTarget.classList.contains(sidebarHiddenClassName)
      }
      try {
        const raw = window.localStorage.getItem(sidebarStorageKey)
        return raw === 'hidden' || raw === 'collapsed'
      } catch {
        return sidebarHiddenTarget.classList.contains(sidebarHiddenClassName)
      }
    }

    const persistNavState = () => {
      if (!navStorageKey) {
        return
      }
      try {
        window.localStorage.setItem(navStorageKey, JSON.stringify(navState))
      } catch {
      }
    }

    const setSidebarHidden = (hidden, runtimeOptions) => {
      const persist = !(runtimeOptions && runtimeOptions.persist === false)
      sidebarHiddenTarget.classList.toggle(sidebarHiddenClassName, hidden === true)
      if (options && typeof options.onSidebarHiddenChange === 'function') {
        options.onSidebarHiddenChange(hidden === true)
      }
      if (!persist || !sidebarStorageKey) {
        return
      }
      try {
        window.localStorage.setItem(sidebarStorageKey, hidden === true ? 'hidden' : 'visible')
      } catch {
      }
    }

    const applyPersistedNodeState = (nextState) => {
      details.forEach((detail) => {
        const navKey = detail.getAttribute('data-nav-key') || ''
        if (!navKey) {
          return
        }
        if (Object.prototype.hasOwnProperty.call(nextState, navKey)) {
          detail.open = nextState[navKey] === true
          return
        }
        detail.open = defaultOpenByKey.get(navKey) === true
      })
    }

    applyPersistedNodeState(navState)

    details.forEach((detail) => {
      const navKey = detail.getAttribute('data-nav-key') || ''
      detail.addEventListener('toggle', () => {
        if (!navKey) {
          return
        }
        navState[navKey] = detail.open === true
        persistNavState()
      })
    })

    const expandAncestors = (element) => {
      let current = element && typeof element.closest === 'function'
        ? element.closest('details[data-nav-key]')
        : null
      while (current) {
        current.open = true
        const navKey = current.getAttribute('data-nav-key') || ''
        if (navKey) {
          navState[navKey] = true
        }
        current = current.parentElement && typeof current.parentElement.closest === 'function'
          ? current.parentElement.closest('details[data-nav-key]')
          : null
      }
      persistNavState()
    }

    const syncActiveLink = () => {
      const currentTargetId = getCurrentTargetId()
      links.forEach((link) => {
        const isActive = Boolean(currentTargetId) && link.getAttribute(targetAttribute) === currentTargetId
        link.classList.toggle('is-active', isActive)
        if (isActive) {
          link.setAttribute('aria-current', 'location')
          expandAncestors(link)
        } else {
          link.removeAttribute('aria-current')
        }
      })
    }

    const revealTarget = (targetId) => {
      if (!targetId) {
        syncActiveLink()
        return
      }
      const matchingLink = links.find((link) => link.getAttribute(targetAttribute) === targetId)
      if (!matchingLink) {
        syncActiveLink()
        return
      }
      if (sidebarHiddenTarget.classList.contains(sidebarHiddenClassName)) {
        setSidebarHidden(false)
      }
      expandAncestors(matchingLink)
      syncActiveLink()
    }

    hideButtons.forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault()
        setSidebarHidden(true)
      })
    })

    showButtons.forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault()
        setSidebarHidden(false)
      })
    })

    links.forEach((link) => {
      link.addEventListener('click', (event) => {
        if (!options || typeof options.onNavigate !== 'function') {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        options.onNavigate(link.getAttribute(targetAttribute) || '', event)
      })
    })

    setSidebarHidden(loadSidebarHidden(), { persist: false })
    syncActiveLink()

    const handleHashChange = () => {
      revealTarget(getCurrentTargetId())
    }

    if (!options || options.listenToHashChange !== false) {
      window.addEventListener('hashchange', handleHashChange)
    }

    const handleStorage = (event) => {
      if (event.key === sidebarStorageKey) {
        setSidebarHidden(loadSidebarHidden(), { persist: false })
        return
      }
      if (event.key === navStorageKey) {
        const reloaded = loadJsonStorage(navStorageKey, {})
        Object.keys(navState).forEach((navKey) => {
          delete navState[navKey]
        })
        Object.assign(navState, reloaded)
        applyPersistedNodeState(reloaded)
        revealTarget(getCurrentTargetId())
      }
    }

    window.addEventListener('storage', handleStorage)

    return {
      items: items,
      revealTarget: revealTarget,
      setSidebarHidden: setSidebarHidden,
      syncActiveLink: syncActiveLink,
    }
  }

  global.ReviewTreeNavControl = {
    init: init,
  }
})(window)
