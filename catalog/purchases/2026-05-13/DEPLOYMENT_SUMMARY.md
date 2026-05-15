# Phase D Review - Deployment Summary

## Status: Ready to Deploy

All code is committed and ready. The mss-one-offs permission fix is implemented in the NixOS configuration.

## What Was Built

### 1. Full UI Integration (`phase_d_review_integrated.html`)
- 264KB self-contained HTML file
- All modular components embedded
- 55 products from 2026-05-13 pending purchases
- Market research with LitAlerts competitor data
- Hierarchical navigation (Site → Category → Subcategory → Variant → Brand)

**Features:**
- ✅ Discrete $0.25 price step controls (no dragging)
- ✅ Approve/reject at row and group levels
- ✅ Inline competitor summaries (median, range, top price)
- ✅ Competitor drawer (side panel, no new tabs)
- ✅ Auto-save to localStorage
- ✅ Export changes to JSON
- ✅ Fixed nav sidebar (Esc to toggle)
- ✅ Real-time GM calculations
- ✅ Group-level bulk operations

### 2. Infrastructure Fix (NixOS Config)
Fixed mss-one-offs module to make slots directory group-writable.

**Repos updated:**
- `mostly-static-sites`: commit 9c8f593
- `nixos-sbc`: commits ac6c66a, 94f5b32

### 3. Upload Tooling
- `automation/scripts/upload-to-mss` - Upload script (normal user)

## To Deploy and Get Your URL

### Step 1: Deploy the NixOS Config

```bash
cd /home/amp-local/src/nixos-sbc
sudo scripts/deploy-vps-3
```

Or manually:
```bash
cd /home/amp-local/src/nixos-sbc
sudo nixos-rebuild switch --flake .#vps-nixos-3
```

This applies the permission fix (one-time deployment).

### Step 2: Upload the Review HTML

```bash
cd /home/amp-local/src/automation
scripts/upload-to-mss catalog/purchases/2026-05-13/phase_d_review_integrated.html "Phase D Review 2026-05-13"
```

This will output:
```
✅ Upload successful!

URL: http://vps-nixos-3.squeaker-court.ts.net:8613/one-offs/<nonce>/
TTL: 86400 seconds (24 hours)
```

## What Changed in the Fix

**File**: `mostly-static-sites/nix/modules/mss-one-offs.nix:229`

```diff
- "d ${cfg.dataDir}/slots       0750 ${cfg.user} ${cfg.group} -"
+ "d ${cfg.dataDir}/slots       2770 ${cfg.user} ${cfg.group} -"
```

**Effect**:
- Before: Only `mss-one-offs` user could write to slots/
- After: Anyone in `mss-one-offs` group can write to slots/
- Daemon can now rename group-owned directories from incoming/ to slots/

## Verification After Deployment

Test that uploads work:

```bash
# Should succeed without sudo
echo "test" > /tmp/test.html
scripts/upload-to-mss /tmp/test.html "Test upload"
```

If it works, you'll get a URL. If not, it will show the permission error.

## Commits

### mostly-static-sites
- `9c8f593` - fix: Make mss-one-offs slots directory group-writable

### nixos-sbc  
- `ac6c66a` - fix: Update mostlyStaticSites to use local path for testing
- `94f5b32` - feat: Add deployment script for vps-nixos-3

### automation
- `f3b2c69` - task: Fix mss-one-offs slots directory permissions (empty commit)
- `25fff6d` - feat: Add mss-one-offs permission fix and upload scripts
- `2351391` - Complete task f3b2c69
- `ab29381` - [infrastructure] Document mss-one-offs permission issue
- Plus 4 earlier commits for UI component packages

## Next Steps After Getting URL

Once you have the URL and can review the interface, we can:
1. Add hierarchical price cascade with confirmation
2. Add MSO brand marking with confirmation
3. Add keyboard shortcuts (↑↓←→ A/R)
4. Add server-side persistence endpoint
5. Add visual state indicators in nav tree

All the modular infrastructure is in place to add these features incrementally.
