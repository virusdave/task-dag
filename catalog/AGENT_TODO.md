Handoff Updated: 2026-05-12 (resume runbook landed; remote VPS3 agent should start here)

Source thread: https://ampcode.com/threads/T-019e1a0f-75c6-71e3-ac6c-5e2133bb48bd
Predecessor (stuck) thread: T-019e191b-0112-72a2-9ab7-47374ebb434b

## Read these first, in order

1. [`purchases/RESUME_RUNBOOK.md`](./purchases/RESUME_RUNBOOK.md) — operational
   guide for any agent (including remote `vps-nixos-3.squaker-court.ts.net`)
   picking up the recurring "produce pending purchases proposal" workflow on a
   host that did not originate the work. Covers bootstrap, discovery,
   in-flight order state, the partially-correct Midtown 131845 resume plan,
   and decisions on record.
2. [`../docs/sweed/catalog/produce-pending-purchase-proposal.md`](../docs/sweed/catalog/produce-pending-purchase-proposal.md)
   — canonical spec of what the workflow must produce. Read after the runbook.
3. [`purchases/2026-05-11/HANDOFF.md`](./purchases/2026-05-11/HANDOFF.md) —
   per-packet narrative state for the 2026-05-11 round: why a first apply
   was rolled back, what the scanned manifest corrects, and the
   per-distributor-SKU correction table.

## In-flight snapshot

- **Bronx 131642 (N&M Farms):** live and correct. Do NOT recreate or disable.
- **Midtown 131845 (Stop 31 LLC / 10FF Distribution):** bad first-round apply
  rolled back; 41 products + 41 groups disabled. Strains/effects/flavors
  created remain active. Manifest at
  [`10FF Distribution.pdf`](./10FF%20Distribution.pdf), parsed into
  [`purchases/2026-05-11/manifest_10ff.json`](./purchases/2026-05-11/manifest_10ff.json),
  is the source of truth for SKU decoding. Manifest-first parse layer is wired
  into [`purchases/2026-05-11/_legacy_patches.py`](./purchases/2026-05-11/_legacy_patches.py).
- **New orders since 2026-05-11:** discover at runtime per RESUME_RUNBOOK.md
  section 4. Fold Midtown-side new orders into the Stop 31 re-run; new
  Bronx-side orders get a new dated packet directory.

## Immediate next steps (resumable on VPS3)

Per `purchases/RESUME_RUNBOOK.md` section 5:

1. Verify manifest count = 32.
2. Regenerate the Midtown packet (`generate_combined_pending_packet.py`).
3. Add Dutchie URL pre-filter in the generator + stamp METRC tags onto rows.
4. Review HTML in Firefox (or via `python -m http.server` from a workstation).
5. Re-apply Midtown ONLY (do not re-touch Bronx).
6. Image quality pass (deferred).
7. `page-dave` on completion.

## Decisions on record (do not relitigate)

- Stop 31 + co-located brands draft to 67.5% GM; marketing discounts via promos.
- Dutchie images forbidden everywhere.
- Bronx 131642 already correct — do not touch.
- Smartbud `Ground Flower 1/2oz` SKUs are `<Strain> Shake 14g`.
- Jungle Girl 5pks are multi-cultivar assortments (no single strain).
- Canonical brand names: `Moonlit Hash Co`, `Preferred Gardens`.
- Disabled products/groups stay disabled; the active strains/effects/flavors
  created alongside them remain active.
