(function () {
  const STYLE_ID = 'review-packet-ui-style';
  const BAND_CONFIG = {
    near: { rank: 0 },
    mid: { rank: 1 },
    far: { rank: 2 },
    very_far: { rank: 3 },
    unknown: { rank: 3 },
  };

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.ladder-competitor { transition: top 120ms ease-out; }';
    document.head.appendChild(style);
  }

  function parseDistanceMeta(mark) {
    const title = mark.getAttribute('title') || '';
    const bandMatch = title.match(/(near|mid|far|very_far|unknown)(?: \(([0-9.]+)mi\))?$/i);
    const bandFromClass = ['near', 'mid', 'far', 'very_far', 'unknown'].find((band) => mark.classList.contains(band));
    const band = String(mark.dataset.distanceBand || (bandMatch && bandMatch[1]) || bandFromClass || 'unknown').toLowerCase();
    const milesRaw = mark.dataset.distanceMiles || (bandMatch && bandMatch[2]) || '';
    const miles = milesRaw === '' ? null : Number.parseFloat(milesRaw);
    return {
      band: Object.prototype.hasOwnProperty.call(BAND_CONFIG, band) ? band : 'unknown',
      miles: Number.isFinite(miles) ? miles : null,
    };
  }

  function getBandWindow(detail, band) {
    if (detail) {
      if (band === 'near') return { start: 18, end: 34 };
      if (band === 'mid') return { start: 36, end: 52 };
      if (band === 'far') return { start: 54, end: 70 };
      return { start: 72, end: 88 };
    }
    if (band === 'near') return { start: 8, end: 12 };
    if (band === 'mid') return { start: 14, end: 18 };
    if (band === 'far') return { start: 20, end: 24 };
    return { start: 26, end: 30 };
  }

  function applyLadderLayout(ladder) {
    const marks = Array.from(ladder.querySelectorAll('.ladder-competitor'));
    if (marks.length === 0) {
      return;
    }
    const detail = ladder.dataset.ladderMode === 'detail' || ladder.getBoundingClientRect().height >= 150;
    const groups = new Map();
    marks.forEach((mark, index) => {
      const meta = parseDistanceMeta(mark);
      const entry = { mark: mark, index: index, band: meta.band, miles: meta.miles };
      const existing = groups.get(meta.band) || [];
      existing.push(entry);
      groups.set(meta.band, existing);
    });

    groups.forEach((entries, band) => {
      entries.sort((left, right) => {
        const leftMiles = left.miles === null ? Number.POSITIVE_INFINITY : left.miles;
        const rightMiles = right.miles === null ? Number.POSITIVE_INFINITY : right.miles;
        return leftMiles - rightMiles || left.index - right.index;
      });

      const finiteMiles = entries
        .map((entry) => entry.miles)
        .filter((value) => value !== null && Number.isFinite(value));
      const minMiles = finiteMiles.length > 0 ? Math.min.apply(null, finiteMiles) : null;
      const maxMiles = finiteMiles.length > 0 ? Math.max.apply(null, finiteMiles) : null;
      const window = getBandWindow(detail, band);
      const rank = (BAND_CONFIG[band] || BAND_CONFIG.unknown).rank;

      entries.forEach((entry, entryIndex) => {
        let ratio;
        if (entry.miles !== null && minMiles !== null && maxMiles !== null && maxMiles > minMiles) {
          ratio = (entry.miles - minMiles) / (maxMiles - minMiles);
        } else if (entries.length > 1) {
          ratio = entryIndex / (entries.length - 1);
        } else {
          ratio = 0;
        }
        const top = window.start + (window.end - window.start) * clamp(ratio, 0, 1);
        entry.mark.style.top = top.toFixed(1) + 'px';
        entry.mark.style.zIndex = String(30 - (rank * 5 + entryIndex));
      });
    });
  }

  function init() {
    injectStyles();
    Array.from(document.querySelectorAll('.pricing-ladder')).forEach(applyLadderLayout);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
