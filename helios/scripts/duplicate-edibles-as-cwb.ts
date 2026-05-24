// Duplicate the state-dealer "Edibles" category as "EdiblesCWB",
// preserving every attribute setting (booleans, productClass,
// limitType, allowed sizes, image, etc.) and every subcategory
// (including subcategory name + enabled state).
//
// Why this script exists:
//   - Sweed has no `store.product.category.clone` RPC.
//   - `store.product.category.add` silently drops any `subcategories`
//     array you pass to it; the only way to create a subcategory is
//     a SEPARATE `store.product.category.add` call with
//     `parentProductCategoryId` pointing at the new parent.
//   - The add RPC also has no `enabled` field, so freshly-created
//     subcategories default to enabled=true and we need a follow-up
//     `store.product.category.edit` call to mirror the source's
//     enabled state on each child.
//   - The add RPC takes `imageGuid` (uuid), not `image` (url). We
//     parse the uuid portion of the source image url ourselves.
//
// Source schema reference (mined out of the Sweed SPA bundle
// `app.5.18.4.bc36a89f00530c978208.js`, NOT documented anywhere
// else we control):
//
//   store.product.category.add({
//     parentProductCategoryId?: number | null,
//     name: string,
//     productClassId?: number,
//     legalAge?: number | null,
//     limitTypeId?: number | null,
//     imageGuid?: string | null,
//     isSynchronizedWithParent?: boolean | null,
//     isProductStrainEnabled?: boolean | null,
//     isProductScentEnabled?: boolean | null,
//     isProductFlavoringEnabled?: boolean | null,
//     isProductQualityLineEnabled?: boolean | null,
//     isProductStrengthLevelEnabled?: boolean | null,
//     displayCannabinoidRatio?: boolean | null,
//     sizeIds?: number[] | null,
//     productTypeIds?: number[] | null,
//     useBrandImagesOnIos?: boolean | null,
//     isGroupProductsInEcommerce?: boolean | null,
//     isManagerDiscountsAllowed?: boolean | null,
//     isPromoDiscountAllowed?: boolean | null,
//     isLoyaltyAllowed?: boolean | null,
//     isHiddenInApp?: boolean | null,
//     useProductThcInSizeFilter?: boolean | null,
//     displayProductThcInProductCardFirst?: boolean | null,
//     // ommuDefaultFormId, specialTaxProfileId omitted — not present
//     // on the source Edibles category at our state dealer.
//   })
//
// Usage:
//   npx tsx scripts/duplicate-edibles-as-cwb.ts            # dry run
//   npx tsx scripts/duplicate-edibles-as-cwb.ts --apply    # writes

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureDealerContext, callSweedRpcRaw } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

const SOURCE_CATEGORY_NAME = 'Edibles'
const TARGET_CATEGORY_NAME = 'EdiblesCWB'

interface SourceSubcategory {
  id: number
  name: string
  enabled: boolean
}

interface SourceSize {
  id: number
}

interface SourceCategory {
  id: number
  name: string
  enabled: boolean
  image?: string | null
  productClass?: { id: number } | null
  limitType?: { id: number } | null
  sizes?: SourceSize[]
  subcategories?: SourceSubcategory[]
  isProductStrainEnabled?: boolean
  isProductScentEnabled?: boolean
  isProductFlavoringEnabled?: boolean
  isProductQualityLineEnabled?: boolean
  isProductStrengthLevelEnabled?: boolean
  displayCannabinoidRatio?: boolean
  isGroupProductsInEcommerce?: boolean
  isSynchronizedWithParent?: boolean
  useBrandImagesOnIos?: boolean
  isManagerDiscountsAllowed?: boolean
  isPromoDiscountAllowed?: boolean
  isLoyaltyAllowed?: boolean
  isHiddenInApp?: boolean
  useProductThcInSizeFilter?: boolean
  displayProductThcInProductCardFirst?: boolean
}

function extractImageGuid(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null
  const m = imageUrl.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return m ? m[1].toLowerCase() : null
}

function buildParentAddParams(src: SourceCategory): Record<string, unknown> {
  return {
    name: TARGET_CATEGORY_NAME,
    productClassId: src.productClass?.id,
    limitTypeId: src.limitType?.id ?? null,
    imageGuid: extractImageGuid(src.image),
    sizeIds: (src.sizes ?? []).map((s) => s.id),
    isSynchronizedWithParent: src.isSynchronizedWithParent ?? false,
    isProductStrainEnabled: src.isProductStrainEnabled ?? false,
    isProductScentEnabled: src.isProductScentEnabled ?? false,
    isProductFlavoringEnabled: src.isProductFlavoringEnabled ?? false,
    isProductQualityLineEnabled: src.isProductQualityLineEnabled ?? false,
    isProductStrengthLevelEnabled: src.isProductStrengthLevelEnabled ?? false,
    displayCannabinoidRatio: src.displayCannabinoidRatio ?? false,
    isGroupProductsInEcommerce: src.isGroupProductsInEcommerce ?? true,
    useBrandImagesOnIos: src.useBrandImagesOnIos ?? false,
    isManagerDiscountsAllowed: src.isManagerDiscountsAllowed ?? true,
    isPromoDiscountAllowed: src.isPromoDiscountAllowed ?? true,
    isLoyaltyAllowed: src.isLoyaltyAllowed ?? true,
    isHiddenInApp: src.isHiddenInApp ?? false,
    useProductThcInSizeFilter: src.useProductThcInSizeFilter ?? false,
    displayProductThcInProductCardFirst: src.displayProductThcInProductCardFirst ?? false,
  }
}

function buildChildAddParams(parentId: number, sub: SourceSubcategory): Record<string, unknown> {
  return {
    name: sub.name,
    productClassId: 1, // required field; matches Edibles (Cannabis)
    parentProductCategoryId: parentId,
    isSynchronizedWithParent: true,
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function main(): Promise<number> {
  const apply = process.argv.includes('--apply')
  const env = getWorkerEnv()
  const startedAt = nowIso()
  const summary: Record<string, unknown> = {
    mode: apply ? 'apply' : 'dryrun',
    startedAt,
    stateDealerId: env.sweedStateDealerId,
    sourceCategoryName: SOURCE_CATEGORY_NAME,
    targetCategoryName: TARGET_CATEGORY_NAME,
  }

  await withSweedSession(async () => {
    await ensureDealerContext(env.sweedStateDealerId)

    // 1. Fetch source by name.
    const list = (await callSweedRpcRaw<unknown>('store.product.category.list', {})) as Array<
      Record<string, unknown>
    >
    const sourceLite = list.find(
      (c) => typeof c.name === 'string' && (c.name as string).toLowerCase() === SOURCE_CATEGORY_NAME.toLowerCase(),
    )
    if (!sourceLite) throw new Error(`Source category "${SOURCE_CATEGORY_NAME}" not found.`)
    const src = (await callSweedRpcRaw<unknown>('store.product.category.get', {
      id: sourceLite.id,
    })) as SourceCategory
    summary.sourceCategoryId = src.id

    // Reject if a target already exists, to keep the script idempotent
    // without doing partial-update logic.
    const existingTarget = list.find(
      (c) =>
        typeof c.name === 'string' &&
        (c.name as string).toLowerCase() === TARGET_CATEGORY_NAME.toLowerCase(),
    )
    if (existingTarget) {
      throw new Error(
        `A category named "${TARGET_CATEGORY_NAME}" already exists (id=${existingTarget.id}). Aborting to avoid duplicates.`,
      )
    }

    const parentParams = buildParentAddParams(src)
    const childPlans = (src.subcategories ?? []).map((s) => ({
      source: s,
      addParams: null as Record<string, unknown> | null, // filled after parent created
      editParams: null as Record<string, unknown> | null, // for enabled state
    }))
    summary.parentAddParams = parentParams
    summary.subcategoryCount = childPlans.length
    summary.subcategoryPlans = childPlans.map((p) => ({
      sourceId: p.source.id,
      sourceName: p.source.name,
      sourceEnabled: p.source.enabled,
    }))

    console.log(JSON.stringify(summary, null, 2))
    console.log(
      `\nMode: ${apply ? 'APPLY' : 'DRY RUN'} — ${
        apply ? 'WILL WRITE' : 'no Sweed writes will be issued'
      }`,
    )

    if (!apply) {
      console.log('\nPass --apply to execute.')
      return
    }

    // 2. Create the parent.
    console.log(`\nCreating parent category "${TARGET_CATEGORY_NAME}"…`)
    const parentResult = (await callSweedRpcRaw<{ id: number; name: string }>(
      'store.product.category.add',
      parentParams,
    )) as { id: number; name: string }
    console.log(`  -> created id=${parentResult.id} name=${parentResult.name}`)
    summary.parentResult = parentResult

    // 3. Create each child. Disable AFTER if source was disabled.
    const childResults: Array<Record<string, unknown>> = []
    for (const plan of childPlans) {
      const addParams = buildChildAddParams(parentResult.id, plan.source)
      plan.addParams = addParams
      console.log(`\nCreating child "${plan.source.name}" (source enabled=${plan.source.enabled})…`)
      const childResult = (await callSweedRpcRaw<{ id: number; name: string }>(
        'store.product.category.add',
        addParams,
      )) as { id: number; name: string }
      console.log(`  -> created id=${childResult.id} name=${childResult.name}`)
      let editResult: unknown = null
      if (plan.source.enabled === false) {
        const editParams = { id: childResult.id, enabled: false }
        plan.editParams = editParams
        console.log(`  -> disabling to match source (enabled=false)…`)
        editResult = await callSweedRpcRaw<unknown>('store.product.category.edit', editParams)
      }
      childResults.push({
        sourceId: plan.source.id,
        sourceName: plan.source.name,
        sourceEnabled: plan.source.enabled,
        newId: childResult.id,
        newName: childResult.name,
        addParams,
        editParams: plan.editParams,
        addResult: childResult,
        editResult: editResult ? '<edited>' : null,
      })
    }
    summary.childResults = childResults

    // 4. Re-fetch the new parent to confirm subcategories landed.
    const verify = await callSweedRpcRaw<unknown>('store.product.category.get', {
      id: parentResult.id,
    })
    summary.verifyParentAfter = verify
    console.log(`\nVerification (new "${TARGET_CATEGORY_NAME}" .get):`)
    console.log(JSON.stringify(verify, null, 2))
  })

  summary.completedAt = nowIso()

  // Persist results under categories/ alongside earlier one-offs.
  const __filename = fileURLToPath(import.meta.url)
  const repoRoot = resolve(dirname(__filename), '..', '..')
  const outDir = resolve(repoRoot, 'categories', '2026-05-24-edibles-cwb-duplicate')
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, apply ? 'results_apply.json' : 'results_dryrun.json')
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n')
  console.log(`\nWrote ${outPath}`)
  return 0
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
