#!/usr/bin/env python3
"""Add draggable ladder script to all detail pages."""

from pathlib import Path

DETAILS_DIR = Path("/home/amp-local/src/automation/catalog/purchases/2026-05-13/pending_purchases_2026_05_13_details")

DRAGGABLE_SCRIPT = """
  <script>
    // Draggable proposed-price marker
    function moneyText(value) {
      if (value === null || value === undefined || isNaN(value)) return '-';
      return '$' + value.toFixed(2);
    }
    function updateProposedMarker(marker, newPrice) {
      var ladder = marker.closest('.pricing-ladder');
      if (!ladder) return;
      var domainMin = parseFloat(ladder.dataset.domainMin);
      var domainMax = parseFloat(ladder.dataset.domainMax);
      if (!isFinite(domainMin) || !isFinite(domainMax)) return;
      var cost = parseFloat(ladder.dataset.cost);
      var POST_TAX = 1.13;
      var leftPercent = (newPrice - domainMin) / (domainMax - domainMin) * 100;
      leftPercent = Math.max(0, Math.min(100, leftPercent));
      marker.style.left = leftPercent.toFixed(2) + '%';
      var gmText = '';
      if (isFinite(cost) && cost > 0 && newPrice > 0) {
        var gm = (1 - POST_TAX * cost / newPrice) * 100;
        gmText = gm.toFixed(2) + '% GM';
      } else {
        gmText = 'GM unavailable';
      }
      marker.setAttribute('title', 'Proposed: ' + moneyText(newPrice) + ' (' + gmText + ')');
      
      // Update the head metric if it exists
      var shell = ladder.closest('.pricing-ladder-shell');
      if (shell) {
        var head = shell.querySelector('.pricing-ladder-head .metric');
        if (head) {
          var parts = head.textContent.split('→');
          if (parts.length >= 2) {
            head.innerHTML = parts[0] + '→ ' + moneyText(newPrice) + ' <span class="metric-detail">(' + gmText + ')</span>';
          }
        }
      }
    }
    
    document.querySelectorAll('.ladder-marker.proposed').forEach(function(marker) {
      var ladder = marker.closest('.pricing-ladder');
      if (!ladder) return;
      
      var isDragging = false;
      var domainMin = parseFloat(ladder.dataset.domainMin);
      var domainMax = parseFloat(ladder.dataset.domainMax);
      
      marker.style.cursor = 'ew-resize';
      
      marker.addEventListener('pointerdown', function(e) {
        isDragging = true;
        marker.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      
      marker.addEventListener('pointermove', function(e) {
        if (!isDragging) return;
        var rect = ladder.getBoundingClientRect();
        var x = e.clientX - rect.left;
        var leftPercent = (x / rect.width) * 100;
        var newPrice = domainMin + (domainMax - domainMin) * (leftPercent / 100);
        newPrice = Math.round(newPrice * 2) / 2; // Snap to half dollar
        updateProposedMarker(marker, newPrice);
      });
      
      marker.addEventListener('pointerup', function(e) {
        isDragging = false;
        marker.releasePointerCapture(e.pointerId);
      });
    });
  </script>
"""

for html_file in DETAILS_DIR.glob("*.html"):
    content = html_file.read_text()
    if '<script>' not in content:
        # Insert before </body>
        content = content.replace('</body>', DRAGGABLE_SCRIPT + '\n</body>')
        html_file.write_text(content)

print(f"Added draggable script to {len(list(DETAILS_DIR.glob('*.html')))} files")
