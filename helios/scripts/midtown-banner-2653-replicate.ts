// One-off: replicate Midtown carousel banner 2653 ("GO NY GO NY GO",
// type=Product menu, promoActionId=46333) to the OTHER 3 active
// Midtown screens, leaving each new banner enabled.
//
// Source URL: https://prime.sweedpos.com/settings/screens/app-banner/2653
// Source dealer: Midtown (210705); source screen: 276 ("TV SE Over Kiosks").
// Target active screens (the other 3 enabled in Midtown): 252, 251, 250.
//
// Dry-run by default. Pass `--apply` to actually create + enable.

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID } from '../src/shared/contracts/domain/screens.js'

const MIDTOWN = HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID
const SOURCE_BANNER_ID = '2653'
const SOURCE_SCREEN_ID = 276
const TARGET_SCREEN_IDS = [252, 251, 250] // other 3 enabled Midtown screens (250/251/252; 276 is source)

const APPLY = process.argv.includes('--apply')

interface BannerFull {
  id: string | number
  name: string
  screenId: number
  type: { id: number; name: string }
  layoutType?: { id: number; name: string } | null
  ordering?: number
  duration?: number
  enabled: boolean
  cronExpression?: string | null
  fromDate?: string | null
  toDate?: string | null
  fromTime?: string | null
  toTime?: string | null
  productsDisplayed?: number
  usePromoSchedule?: boolean
  usePromoHeader?: boolean
  showNumberOfItemsInHeader?: boolean
  promoActionId?: string | number | null
  promoAction?: { id?: string | number } | null
  brands?: Array<{ id: number }>
  categories?: Array<{ id: number }>
  subCategories?: Array<{ id: number }>
  productGroups?: Array<{ id: number }>
  productTypes?: Array<{ id: number }>
  products?: Array<{ id: number }>
  sizes?: Array<{ id: number }>
  qualityLines?: Array<{ id: number }>
  unitsInPackage?: number[] | null
  minWholesaleCost?: unknown
  maxWholesaleCost?: unknown
  media?: { id?: string } | null
  totalDuration?: number | null
}

function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null
  const i = value.indexOf('T')
  return i === -1 ? value : value.slice(0, i)
}

function selectorIds(value: Array<{ id: number }> | null | undefined): number[] | null {
  if (!value || !Array.isArray(value) || value.length === 0) return null
  return value.map((v) => v.id)
}

function buildAddPayload(source: BannerFull, targetScreenId: number, ordering: number, enabled: boolean): Record<string, unknown> {
  const promoActionId = source.promoActionId ?? source.promoAction?.id ?? null
  const payload: Record<string, unknown> = {
    name: source.name,
    screenId: targetScreenId,
    typeId: source.type.id,
    ordering,
    duration: source.duration ?? 10,
    enabled,
    fromDate: toDateOnly(source.fromDate ?? null),
    toDate: toDateOnly(source.toDate ?? null),
    cronExpression: source.cronExpression ?? null,
    fromTime: source.fromTime ?? null,
    toTime: source.toTime ?? null,
    productsDisplayed: source.productsDisplayed ?? 3,
    usePromoSchedule: source.usePromoSchedule ?? false,
    usePromoHeader: source.usePromoHeader ?? false,
    showNumberOfItemsInHeader: source.showNumberOfItemsInHeader ?? false,
    promoActionId: promoActionId === null ? null : String(promoActionId),
    brands: selectorIds(source.brands),
    categories: selectorIds(source.categories),
    subCategories: selectorIds(source.subCategories),
    productGroups: selectorIds(source.productGroups),
    productTypes: selectorIds(source.productTypes),
    products: selectorIds(source.products),
    sizes: selectorIds(source.sizes),
    qualityLines: selectorIds(source.qualityLines),
    unitsInPackage: source.unitsInPackage ?? null,
    minWholesaleCost: source.minWholesaleCost ?? null,
    maxWholesaleCost: source.maxWholesaleCost ?? null,
  }
  if (source.layoutType?.id) payload.layoutTypeId = source.layoutType.id
  if (source.media?.id) payload.mediaId = source.media.id
  return payload
}

function buildEditPayload(detail: BannerFull, enabled: boolean): Record<string, unknown> {
  const promoActionId = detail.promoActionId ?? detail.promoAction?.id ?? null
  const params: Record<string, unknown> = {
    id: detail.id,
    name: detail.name,
    typeId: detail.type.id,
    ordering: detail.ordering ?? 0,
    duration: detail.duration ?? 10,
    enabled,
    fromDate: toDateOnly(detail.fromDate ?? null),
    toDate: toDateOnly(detail.toDate ?? null),
    cronExpression: detail.cronExpression ?? null,
    fromTime: detail.fromTime ?? null,
    toTime: detail.toTime ?? null,
    productsDisplayed: detail.productsDisplayed ?? 3,
    usePromoSchedule: detail.usePromoSchedule ?? false,
    usePromoHeader: detail.usePromoHeader ?? false,
    showNumberOfItemsInHeader: detail.showNumberOfItemsInHeader ?? false,
    promoActionId: promoActionId === null ? null : String(promoActionId),
    brands: selectorIds(detail.brands),
    categories: selectorIds(detail.categories),
    subCategories: selectorIds(detail.subCategories),
    productGroups: selectorIds(detail.productGroups),
    productTypes: selectorIds(detail.productTypes),
    products: selectorIds(detail.products),
    sizes: selectorIds(detail.sizes),
    qualityLines: selectorIds(detail.qualityLines),
    unitsInPackage: detail.unitsInPackage ?? null,
    minWholesaleCost: detail.minWholesaleCost ?? null,
    maxWholesaleCost: detail.maxWholesaleCost ?? null,
  }
  if (detail.layoutType?.id) params.layoutTypeId = detail.layoutType.id
  if (detail.media?.id) params.mediaId = detail.media.id
  return params
}

async function listBanners(screenId: number): Promise<Array<{ id: string; name: string; enabled: boolean; ordering: number | null; totalDuration: number | null; type: string }>> {
  const raw = await callSweedRpc<any[]>(MIDTOWN, 'store.screen.carousel.banner.list', { screenId })
  return (raw ?? []).map((b) => ({
    id: String(b.id),
    name: b.name,
    enabled: b.enabled,
    ordering: b.ordering ?? null,
    totalDuration: b.totalDuration ?? null,
    type: typeof b.type === 'string' ? b.type : b.type?.name,
  }))
}

async function main(): Promise<void> {
  await withSweedSession(async () => {
    console.log(`MODE: ${APPLY ? 'APPLY' : 'DRY-RUN (pass --apply to actually create)'}`)
    const source = await callSweedRpc<BannerFull>(MIDTOWN, 'store.screen.carousel.banner.get', { id: SOURCE_BANNER_ID })
    if (source.screenId !== SOURCE_SCREEN_ID) throw new Error(`Source banner ${SOURCE_BANNER_ID} unexpectedly lives on screen ${source.screenId}, not ${SOURCE_SCREEN_ID}.`)
    if (source.type.id !== 3 || source.type.name !== 'Product menu') {
      throw new Error(`Source banner is type ${JSON.stringify(source.type)}; this script only knows how to clone Product menu banners.`)
    }
    console.log(`SOURCE: banner ${source.id} "${source.name}" on screen ${source.screenId} → promoActionId=${source.promoActionId} duration=${source.duration} ordering=${source.ordering}`)

    for (const targetScreenId of TARGET_SCREEN_IDS) {
      console.log(`\n--- TARGET SCREEN ${targetScreenId} ---`)
      const existing = await listBanners(targetScreenId)
      const dup = existing.find((b) => b.name === source.name)
      if (dup) {
        console.log(`  SKIP: banner "${source.name}" already exists on screen ${targetScreenId} as id=${dup.id} (enabled=${dup.enabled} totalDuration=${dup.totalDuration}).`)
        if (APPLY && !dup.enabled) {
          console.log(`  -> existing duplicate is disabled; enabling it.`)
          const full = await callSweedRpc<BannerFull>(MIDTOWN, 'store.screen.carousel.banner.get', { id: dup.id })
          await callSweedRpc(MIDTOWN, 'store.screen.carousel.banner.edit', buildEditPayload(full, true))
        }
        continue
      }
      const nextOrdering = Math.max(0, ...existing.map((b) => b.ordering ?? 0)) + 1
      const addPayload = buildAddPayload(source, targetScreenId, nextOrdering, false)
      console.log(`  WILL ADD with ordering=${nextOrdering}; payload=`, JSON.stringify(addPayload))
      if (!APPLY) continue

      const addResult = await callSweedRpc<any>(MIDTOWN, 'store.screen.carousel.banner.add', addPayload)
      const newId =
        typeof addResult === 'string' || typeof addResult === 'number'
          ? String(addResult)
          : addResult && typeof addResult === 'object' && 'id' in addResult
            ? String((addResult as { id: unknown }).id)
            : null
      if (!newId) throw new Error(`banner.add returned no id on screen ${targetScreenId} (result=${JSON.stringify(addResult)})`)
      console.log(`  ADDED banner id=${newId}; now enabling.`)

      const newDetail = await callSweedRpc<BannerFull>(MIDTOWN, 'store.screen.carousel.banner.get', { id: newId })
      await callSweedRpc(MIDTOWN, 'store.screen.carousel.banner.edit', buildEditPayload(newDetail, true))

      // verify
      const after = await listBanners(targetScreenId)
      const made = after.find((b) => String(b.id) === newId)
      if (!made) throw new Error(`new banner ${newId} not visible in banner.list on screen ${targetScreenId} after edit.`)
      console.log(`  VERIFIED: id=${made.id} enabled=${made.enabled} totalDuration=${made.totalDuration} name=${JSON.stringify(made.name)}`)
      if (!made.enabled) console.warn(`  WARNING: banner ${made.id} on screen ${targetScreenId} did NOT come back as enabled.`)
      if ((made.totalDuration ?? 0) === 0) console.warn(`  WARNING: banner ${made.id} on screen ${targetScreenId} has totalDuration=0 (no matching in-stock products?).`)
    }

    console.log('\nDONE.')
  })
}

main().catch((error: unknown) => {
  console.error('FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})
