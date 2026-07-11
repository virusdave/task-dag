import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LowInventoryCountBody } from '../../shared/contracts/index.js'
import { pageDave, type PageDavePriority } from '../../worker/runtime/pageDave.js'
import { uploadToMssOneOffs } from '../ads/mssOneOffsUpload.js'

function html(value: string | number | null): string {
  return String(value ?? 'Not reported').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function tagSuffix(tag: string | null): string {
  return tag === null ? 'not reported' : tag.slice(-8)
}

export async function notifyLowInventoryAudit(args: {
  auditId: number
  count: LowInventoryCountBody
  destinationName?: string
  movedQty?: number
  siteLabel: string
}): Promise<void> {
  const { count } = args
  const priority: PageDavePriority = count.classification === 'held'
    ? 4
    : count.classification === 'zero'
      ? 3
      : 2
  const directory = await mkdtemp(join(tmpdir(), 'helios-low-inventory-'))
  try {
    const path = join(directory, 'index.html')
    await writeFile(path, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Low inventory audit</title><style>body{font:16px system-ui;margin:0;background:#f7f2e8;color:#241f18}main{max-width:760px;margin:auto;padding:18px}h1{font-size:1.45rem}dl{display:grid;grid-template-columns:minmax(8rem,35%) 1fr;background:white;border-radius:14px;padding:12px}dt,dd{padding:8px;margin:0;border-bottom:1px solid #eee}dt{font-weight:700}strong{color:#8c2f1e}</style></head><body><main><h1>${html(args.siteLabel)} low-inventory audit</h1><p><strong>${html(count.classification.toUpperCase())}</strong> · audit #${html(args.auditId)}</p><dl><dt>Package</dt><dd>${html(count.inventoryItemId)}</dd><dt>METRC suffix</dt><dd>${html(tagSuffix(count.metrcTag))}</dd><dt>Source</dt><dd>${html(count.sourceLocation)}</dd><dt>Sweed count</dt><dd>${html(count.snapshotCurrentQty)}</dd><dt>Physical count</dt><dd>${html(count.physicalCount)}</dd><dt>Held</dt><dd>${html(count.snapshotHoldQty)}</dd><dt>Action</dt><dd>${args.destinationName ? `Moved ${html(args.movedQty ?? 0)} to ${html(args.destinationName)}` : 'Manual review required; no inventory quantity was changed.'}</dd></dl></main></body></html>`, 'utf8')
    const upload = await uploadToMssOneOffs({
      sourcePath: path,
      note: `Helios low-inventory audit ${args.auditId}`,
      ttlSeconds: 86_400,
    })
    await pageDave(
      `${args.siteLabel}: ${count.classification} count for package ${tagSuffix(count.metrcTag)} ` +
      `(Sweed ${count.snapshotCurrentQty}, physical ${count.physicalCount}). ${upload.publicUrl}`,
      { priority, title: 'Low inventory audit' },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
